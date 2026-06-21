const MODULE_ID = "ship-wheel";

// --------------------------------------------------
// Основные настройки модуля
// --------------------------------------------------

// Минимальный и максимальный размер штурвала в пикселях.
const WHEEL_MIN_SIZE = 80;
const WHEEL_MAX_SIZE = 400;

// Как часто отправлять промежуточный угол другим игрокам.
// 75 мс — это примерно 13 обновлений в секунду. Между ними второй клиент
// дорисовывает движение самостоятельно, поэтому оно остаётся плавным.
const NETWORK_UPDATE_DELAY = 75;

// За какое примерное время удалённый токен догоняет полученный угол.
// Чем меньше число, тем резче реакция; чем больше — тем мягче движение.
const REMOTE_SMOOTHING_TIME = 100;

// Временная блокировка обновляется во время вращения. Если игрок отключился,
// она автоматически перестаёт действовать через указанное время.
const PILOT_LOCK_TIMEOUT = 10000;

// Настройки инерции. Скорость измеряется в градусах в секунду.
// FRICTION отвечает за торможение, START — за минимальную скорость запуска,
// STOP — за скорость, при которой движение считается завершённым.
const INERTIA_FRICTION = 3.2;
const INERTIA_START_SPEED = 20;
const INERTIA_STOP_SPEED = 3;

// Настройки звука: один щелчок на SOUND_STEP пройденных градусов,
// ограничение частоты щелчков и диапазон случайной громкости.
const SOUND_STEP = 60;
const MIN_SOUND_INTERVAL = 60;
const SOUND_VOLUME_MIN = 0.05;
const SOUND_VOLUME_RANGE = 0.2;

// --------------------------------------------------
// Ссылки на HTML-элементы штурвала
// --------------------------------------------------

// wheelElement — общий контейнер.
// wheelBodyElement — видимая вращающаяся картинка.
// handleElement — прозрачная область в центре для перемещения.
let wheelElement = null;
let wheelBodyElement = null;
let handleElement = null;

// Текущее положение, размер и угол картинки штурвала.
// Эти значения не сбрасываются при закрытии, поэтому повторно открытый
// штурвал появляется там же и того же размера.
let wheelSize = 180;
let wheelX = 100;
let wheelY = 100;
let wheelRotation = 0;
let wheelVelocity = 0;

// --------------------------------------------------
// Состояние текущего действия указателя
// --------------------------------------------------

// interactionMode принимает "rotate", "drag", "resize" или null.
// activePointerId не позволяет второму пальцу/указателю вмешаться в действие.
let interactionMode = null;
let activePointerId = null;
// Пока Foundry подтверждает блокировку, действие ещё не считается начатым.
let pendingRotationPointerId = null;

// Токен фиксируется в момент захвата. Даже если выделение изменится во время
// вращения, штурвал продолжит управлять именно этим токеном.
let activeToken = null;
let activeTokenRotation = null;

// Последний угол указателя и время движения нужны для расчёта дельты и скорости.
let lastAngle = null;
let lastMoveTime = null;

// Смещение между указателем и левым верхним углом штурвала при перемещении.
let offsetX = 0;
let offsetY = 0;

// --------------------------------------------------
// Состояние инерции
// --------------------------------------------------

// requestAnimationFrame возвращает идентификатор кадра. По нему анимацию
// можно отменить, например когда пользователь снова хватает штурвал.
let inertiaFrame = null;
let inertiaToken = null;
let inertiaTokenRotation = null;
let inertiaLastTime = null;

// --------------------------------------------------
// Звук, сеть и удалённая анимация
// --------------------------------------------------

let soundTemplate = null;
let soundAccumulator = 0;
let lastSoundTime = 0;

// Ограничитель частоты сети и очередь обновлений документа токена.
let lastNetworkUpdate = 0;
let warnedNoToken = false;
let networkUpdateInFlight = false;
const pendingTokenUpdates = [];

// Каждое новое касание штурвала получает уникальный sessionId. Благодаря этому
// удалённый клиент не соединяет конец прошлого вращения с началом нового.
let rotationSessionId = null;
let rotationSessionCounter = 0;

// Для каждого удалённо вращаемого токена храним текущий и целевой угол.
const remoteRotations = new Map();
let remoteAnimationFrame = null;

// Промежуточный угол передаётся через флаг TokenDocument, а не через rotation.
// Поэтому Foundry не меняет mesh параллельно с нашим интерполятором и не
// возникает тикающего движения вперёд-назад. rotation сохраняется лишь в конце.
Hooks.on("updateToken", (document, change, options, userId) => {
    // При почти одновременном захвате оба клиента могут успеть отправить запрос.
    // Сервер применит их последовательно; клиент, увидевший чужую подтверждённую
    // блокировку, прекращает своё локальное вращение.
    const changedFlags = change.flags?.[MODULE_ID];
    const locallyControlledToken = activeToken ?? inertiaToken;
    if (
        userId !== game.user.id &&
        locallyControlledToken?.id === document.id &&
        changedFlags?.pilotLock
    ) {
        const currentLock = document.getFlag(MODULE_ID, "pilotLock");
        if (isPilotLockActive(currentLock) && currentLock.userId !== game.user.id) {
            abortLocalRotationForPilotLock();
            ui.notifications.warn("У штурвала сейчас другой пилот");
        }
    }

    if (userId === game.user.id) return;
    if (document.parent?.id !== canvas.scene?.id) return;

    const token = canvas.tokens.get(document.id);
    if (!token?.mesh) return;

    const flagChange = change.flags?.[MODULE_ID];
    const moduleOptions = options?.[MODULE_ID];
    const hasLiveRotation = Number.isFinite(flagChange?.liveRotation);
    const hasFinalRotation = Number.isFinite(change.rotation);
    if (!hasLiveRotation && !hasFinalRotation) return;

    const rotation = hasLiveRotation
        ? flagChange.liveRotation
        : Number.isFinite(moduleOptions?.rotation)
            ? moduleOptions.rotation
            : change.rotation;
    const sessionId = flagChange?.sessionId ?? moduleOptions?.sessionId ?? null;

    applyRemoteRotation(
        token,
        rotation,
        hasFinalRotation,
        hasLiveRotation || Number.isFinite(moduleOptions?.rotation),
        sessionId
    );
});

Hooks.on("getSceneControlButtons", (controls) => {
    // Добавляем собственную группу инструментов на левую панель Foundry.
    controls[MODULE_ID] = {
        name: MODULE_ID,
        title: "Штурвал",
        icon: "fas fa-sailboat",
        layer: "tokens",
        tools: {
            wheel: {
                name: "wheel",
                title: "Открыть штурвал",
                icon: "fas fa-dharmachakra",
                button: true,
                onClick: toggleWheel
            }
        }
    };
});

function toggleWheel() {
    // Повторное нажатие той же кнопки работает как переключатель: если
    // штурвал уже открыт — закрываем его, иначе создаём интерфейс.
    if (wheelElement) {
        closeWheel();
        return;
    }

    // Шаблон звука клонируется для каждого щелчка. Так несколько коротких
    // звуков могут накладываться друг на друга без обрыва предыдущего.
    soundTemplate = new Audio(`modules/${MODULE_ID}/assets/sounds/wheel1.mp3`);
    soundTemplate.preload = "auto";

    wheelElement = document.createElement("div");
    wheelBodyElement = document.createElement("div");
    handleElement = document.createElement("div");
    const resizeElement = document.createElement("div");

    // Object.assign позволяет задать сразу группу CSS-свойств элемента.
    Object.assign(wheelElement.style, {
        position: "fixed",
        left: `${wheelX}px`,
        top: `${wheelY}px`,
        width: `${wheelSize}px`,
        height: `${wheelSize}px`,
        touchAction: "none",
        userSelect: "none"
    });

    Object.assign(wheelBodyElement.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        backgroundImage: `url('modules/${MODULE_ID}/assets/wheel.webp')`,
        backgroundSize: "contain",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        transform: `rotate(${wheelRotation}deg)`,
        cursor: "grab"
    });

    Object.assign(handleElement.style, {
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: `${wheelSize * 0.15}px`,
        height: `${wheelSize * 0.15}px`,
        borderRadius: "50%",
        background: "transparent",
        cursor: "move",
        touchAction: "none"
    });

    Object.assign(resizeElement.style, {
        position: "absolute",
        right: "4px",
        bottom: "4px",
        width: "12px",
        height: "12px",
        cursor: "nwse-resize",
        zIndex: "10",
        background: "transparent",
        borderRight: "2px solid rgba(210, 170, 90, 0.8)",
        borderBottom: "2px solid rgba(210, 170, 90, 0.8)",
        filter: "drop-shadow(0 0 2px black)",
        touchAction: "none"
    });

    // Сначала собираем структуру элементов, затем добавляем её на страницу.
    wheelElement.append(wheelBodyElement, handleElement, resizeElement);
    document.body.appendChild(wheelElement);

    // Pointer Events одинаково работают с мышью, пером и сенсорным экраном.
    wheelBodyElement.addEventListener("pointerdown", beginRotation);
    handleElement.addEventListener("pointerdown", beginDragging);
    resizeElement.addEventListener("pointerdown", beginResizing);
}

function closeWheel() {
    // Перед удалением интерфейса сохраняем угол возможной инерции и корректно
    // заканчиваем активное действие пользователя.
    pendingRotationPointerId = null;
    cancelInertia(true);
    finishInteraction(false);
    wheelElement?.remove();
    wheelElement = null;
    wheelBodyElement = null;
    handleElement = null;
    soundTemplate = null;
    soundAccumulator = 0;
    wheelVelocity = 0;
}

async function beginRotation(event) {
    event.preventDefault();

    // Если штурвал ещё крутился по инерции, фиксируем её результат до начала
    // новой независимой сессии вращения.
    cancelInertia(true);

    const token = canvas.tokens.controlled[0] ?? null;
    const sessionId = `${game.user.id}:${Date.now()}:${++rotationSessionCounter}`;

    // Для выбранного токена сначала пытаемся получить временную блокировку.
    // Если блокировка другого игрока ещё действует, вращение не начинается.
    if (token) {
        const existingLock = token.document.getFlag(MODULE_ID, "pilotLock");
        if (isPilotLockActive(existingLock) && existingLock.userId !== game.user.id) {
            ui.notifications.warn("У штурвала сейчас другой пилот");
            return;
        }

        pendingRotationPointerId = event.pointerId;

        try {
            await token.document.update({
                [`flags.${MODULE_ID}.pilotLock`]: createPilotLock(sessionId)
            });
        } catch (error) {
            pendingRotationPointerId = null;
            console.error(`${MODULE_ID} | Не удалось получить управление токеном`, error);
            ui.notifications.warn("Не удалось получить управление штурвалом");
            return;
        }

        // Пользователь мог отпустить указатель, пока сервер отвечал.
        if (pendingRotationPointerId !== event.pointerId) {
            await releasePilotLock(token, sessionId);
            return;
        }

        // После ответа перечитываем флаг. Это закрывает гонку, когда два игрока
        // нажали почти одновременно и отправили запросы до получения ответа.
        const confirmedLock = token.document.getFlag(MODULE_ID, "pilotLock");
        if (confirmedLock?.sessionId !== sessionId || confirmedLock.userId !== game.user.id) {
            pendingRotationPointerId = null;
            ui.notifications.warn("У штурвала сейчас другой пилот");
            return;
        }
    }

    pendingRotationPointerId = null;
    rotationSessionId = sessionId;

    interactionMode = "rotate";
    activePointerId = event.pointerId;
    activeToken = token;
    // Берём фактический визуальный угол mesh. Документ может немного отставать,
    // если предыдущее финальное сетевое обновление ещё стоит в очереди.
    activeTokenRotation = activeToken?.mesh
        ? activeToken.mesh.rotation * 180 / Math.PI
        : activeToken?.document.rotation ?? null;
    if (activeToken) remoteRotations.delete(activeToken.id);
    wheelVelocity = 0;
    lastMoveTime = performance.now();

    if (!activeToken && !warnedNoToken) {
        ui.notifications.warn("Выделите токен, который должен вращаться");
        warnedNoToken = true;
    } else if (activeToken) {
        warnedNoToken = false;
    }

    // atan2 возвращает угол луча от центра штурвала к указателю в радианах.
    const { centerX, centerY } = getWheelCenter();
    lastAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    wheelBodyElement.style.cursor = "grabbing";
    // Захват указателя продолжает присылать события даже за границами элемента.
    wheelElement.setPointerCapture?.(event.pointerId);
}

function beginDragging(event) {
    event.preventDefault();
    event.stopPropagation();
    cancelInertia(true);

    interactionMode = "drag";
    activePointerId = event.pointerId;
    offsetX = event.clientX - wheelElement.offsetLeft;
    offsetY = event.clientY - wheelElement.offsetTop;
    wheelElement.setPointerCapture?.(event.pointerId);
}

function beginResizing(event) {
    event.preventDefault();
    event.stopPropagation();
    cancelInertia(true);

    interactionMode = "resize";
    activePointerId = event.pointerId;
    wheelElement.setPointerCapture?.(event.pointerId);
}

document.addEventListener("pointermove", (event) => {
    // Глобальный обработчик направляет движение в функцию активного режима.
    if (!wheelElement || event.pointerId !== activePointerId) return;

    if (interactionMode === "resize") {
        resizeWheel(event);
    } else if (interactionMode === "rotate") {
        rotateWheel(event);
    } else if (interactionMode === "drag") {
        dragWheel(event);
    }
});

document.addEventListener("pointerup", (event) => {
    // Не начинаем вращение задним числом, если указатель отпущен во время
    // ожидания ответа сервера на запрос блокировки.
    if (event.pointerId === pendingRotationPointerId) {
        pendingRotationPointerId = null;
    }
    if (event.pointerId === activePointerId) finishInteraction(true);
});

document.addEventListener("pointercancel", (event) => {
    if (event.pointerId === pendingRotationPointerId) {
        pendingRotationPointerId = null;
    }
    if (event.pointerId === activePointerId) finishInteraction(true);
});

window.addEventListener("blur", () => {
    pendingRotationPointerId = null;
    finishInteraction(true);
});

function resizeWheel(event) {
    const rect = wheelElement.getBoundingClientRect();

    // Берём большую из горизонтальной и вертикальной дельты, сохраняя квадрат.
    const requestedSize = Math.max(event.clientX - rect.left, event.clientY - rect.top);

    // Размер дополнительно ограничен свободным местом до краёв окна.
    const availableSize = Math.max(
        WHEEL_MIN_SIZE,
        Math.min(window.innerWidth - rect.left, window.innerHeight - rect.top)
    );

    wheelSize = clamp(requestedSize, WHEEL_MIN_SIZE, Math.min(WHEEL_MAX_SIZE, availableSize));
    wheelElement.style.width = `${wheelSize}px`;
    wheelElement.style.height = `${wheelSize}px`;
    handleElement.style.width = `${wheelSize * 0.15}px`;
    handleElement.style.height = `${wheelSize * 0.15}px`;
}

function rotateWheel(event) {
    const { centerX, centerY } = getWheelCenter();
    const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    // Разница углов показывает, насколько повернулся указатель с прошлого
    // события. normalizeRadians исправляет скачок между -180° и +180°.
    const deltaDegrees = normalizeRadians(angle - lastAngle) * 180 / Math.PI;
    const now = performance.now();
    const elapsed = Math.max((now - lastMoveTime) / 1000, 1 / 240);

    lastAngle = angle;
    lastMoveTime = now;
    wheelRotation += deltaDegrees;

    // Скорость = пройденный угол / время. Смешивание старой и новой скорости
    // сглаживает шум событий указателя и делает инерцию стабильнее.
    const measuredVelocity = deltaDegrees / elapsed;
    wheelVelocity = wheelVelocity * 0.65 + measuredVelocity * 0.35;

    wheelBodyElement.style.transform = `rotate(${wheelRotation}deg)`;
    addSoundMovement(deltaDegrees);

    if (activeToken && activeTokenRotation !== null) {
        // Локально меняем mesh каждый кадр — это даёт мгновенную плавную реакцию.
        // В сеть угол отправляется реже функцией broadcastRotation.
        activeTokenRotation += deltaDegrees;
        setTokenVisualRotation(activeToken, activeTokenRotation);
        broadcastRotation(activeToken, activeTokenRotation, false, rotationSessionId);
    }
}

function dragWheel(event) {
    // clamp не даёт контейнеру выйти за видимые границы окна.
    wheelX = clamp(
        event.clientX - offsetX,
        0,
        Math.max(0, window.innerWidth - wheelElement.offsetWidth)
    );
    wheelY = clamp(
        event.clientY - offsetY,
        0,
        Math.max(0, window.innerHeight - wheelElement.offsetHeight)
    );

    wheelElement.style.left = `${wheelX}px`;
    wheelElement.style.top = `${wheelY}px`;
}

function finishInteraction(allowInertia) {
    if (!interactionMode) return;

    // Сохраняем нужные значения в локальные переменные до очистки состояния.
    const completedMode = interactionMode;
    const token = activeToken;
    const rotation = activeTokenRotation;

    interactionMode = null;
    activePointerId = null;
    activeToken = null;
    activeTokenRotation = null;
    lastAngle = null;
    lastMoveTime = null;
    soundAccumulator = 0;

    if (wheelBodyElement) wheelBodyElement.style.cursor = "grab";

    // Перемещение и изменение размера не должны запускать старую инерцию.
    if (completedMode !== "rotate") {
        wheelVelocity = 0;
        return;
    }

    inertiaToken = token;
    inertiaTokenRotation = rotation;

    // Инерция запускается только после вращения и при достаточной скорости.
    if (allowInertia && Math.abs(wheelVelocity) >= INERTIA_START_SPEED) {
        startInertia();
        return;
    }

    wheelVelocity = 0;
    persistFinalRotation(token, rotation);
    rotationSessionId = null;
}

function startInertia() {
    // На всякий случай отменяем предыдущий кадр, чтобы не существовало двух
    // параллельных циклов инерции.
    if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);
    inertiaLastTime = performance.now();

    const animate = (now) => {
        if (!wheelElement) {
            cancelInertia(false);
            return;
        }

        // requestAnimationFrame передаёт текущее время. Разница времён делает
        // физику одинаковой на мониторах 60, 120 и 144 Гц. Ограничение 0.05
        // защищает от огромного скачка после зависания или смены вкладки.
        const elapsed = Math.min((now - inertiaLastTime) / 1000, 0.05);
        inertiaLastTime = now;

        // Экспоненциальное торможение плавно уменьшает скорость независимо
        // от количества кадров в секунду.
        wheelVelocity *= Math.exp(-INERTIA_FRICTION * elapsed);

        if (Math.abs(wheelVelocity) < INERTIA_STOP_SPEED) {
            const token = inertiaToken;
            const rotation = inertiaTokenRotation;
            const sessionId = rotationSessionId;
            cancelInertia(false);
            persistFinalRotation(token, rotation, sessionId);
            rotationSessionId = null;
            return;
        }

        // Пройденный за кадр угол = скорость в градусах/сек × время кадра.
        const deltaDegrees = wheelVelocity * elapsed;
        wheelRotation += deltaDegrees;
        wheelBodyElement.style.transform = `rotate(${wheelRotation}deg)`;
        addSoundMovement(deltaDegrees);

        if (inertiaToken && inertiaTokenRotation !== null) {
            inertiaTokenRotation += deltaDegrees;
            setTokenVisualRotation(inertiaToken, inertiaTokenRotation);
            broadcastRotation(inertiaToken, inertiaTokenRotation, false, rotationSessionId);
        }

        inertiaFrame = requestAnimationFrame(animate);
    };

    inertiaFrame = requestAnimationFrame(animate);
}

function cancelInertia(persist) {
    // persist=true означает: перед остановкой нужно отправить итоговый угол.
    if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);

    const token = inertiaToken;
    const rotation = inertiaTokenRotation;
    inertiaFrame = null;
    inertiaToken = null;
    inertiaTokenRotation = null;
    inertiaLastTime = null;
    wheelVelocity = 0;

    if (persist) {
        persistFinalRotation(token, rotation, rotationSessionId);
        rotationSessionId = null;
    }
}

function persistFinalRotation(token, rotation, sessionId = rotationSessionId) {
    if (!token || rotation === null) return;

    // Финальное обновление отличается от промежуточного: оно записывает
    // настоящий rotation в документ Foundry, чтобы угол сохранился в мире.
    broadcastRotation(token, rotation, true, sessionId);
}

function broadcastRotation(token, rotation, final, sessionId) {
    const now = performance.now();

    // Финал отправляется всегда. Промежуточные значения ограничиваются по
    // времени, чтобы не создавать десятки сетевых запросов каждый кадр.
    if (!final && now - lastNetworkUpdate < NETWORK_UPDATE_DELAY) return;
    lastNetworkUpdate = now;

    // Одновременно выполняется только одно обновление документа. Если за это
    // время угол изменился несколько раз, в очередь попадёт только самый свежий.
    // Это не позволяет запоздавшему старому ответу открутить токен назад.
    queueTokenDocumentUpdate(token, rotation, final, sessionId);
}

function queueTokenDocumentUpdate(token, rotation, final, sessionId) {
    const update = { token, rotation, final, sessionId };

    if (final) {
        // Финал заменяет ещё не отправленные промежуточные значения своей
        // сессии, но никогда не вытесняется обновлениями следующей сессии.
        for (let index = pendingTokenUpdates.length - 1; index >= 0; index--) {
            const pending = pendingTokenUpdates[index];
            if (pending.token === token && pending.sessionId === sessionId && !pending.final) {
                pendingTokenUpdates.splice(index, 1);
            }
        }
        pendingTokenUpdates.push(update);
    } else {
        // Объединяем только промежуточные углы того же токена и той же сессии.
        // Финалы и обновления других сессий сохраняют строгий порядок.
        const existingIndex = pendingTokenUpdates.findIndex((pending) => (
            pending.token === token &&
            pending.sessionId === sessionId &&
            !pending.final
        ));

        if (existingIndex >= 0) {
            pendingTokenUpdates[existingIndex] = update;
        } else {
            pendingTokenUpdates.push(update);
        }
    }

    flushTokenDocumentUpdate();
}

async function flushTokenDocumentUpdate() {
    // Пока предыдущий запрос не завершён, новый не запускаем. Это сохраняет
    // порядок пакетов и не позволяет старому ответу прийти после нового.
    if (networkUpdateInFlight || pendingTokenUpdates.length === 0) return;

    // shift забирает первый элемент очереди по принципу FIFO.
    const update = pendingTokenUpdates.shift();
    networkUpdateInFlight = true;

    try {
        // Перед каждой отправкой убеждаемся, что сессия всё ещё владеет токеном.
        // Это не позволяет запоздавшей очереди проигравшего игрока перехватить
        // управление обратно.
        const currentLock = update.token.document.getFlag(MODULE_ID, "pilotLock");
        if (
            currentLock?.userId !== game.user.id ||
            currentLock?.sessionId !== update.sessionId
        ) return;

        // Во время движения передаём угол через служебный flag. Он синхронизируется
        // Foundry, но сам по себе не поворачивает изображение токена.
        // В финале очищаем liveRotation и сохраняем настоящий rotation.
        const changes = update.final
            ? {
                rotation: normalizeDegrees(update.rotation),
                [`flags.${MODULE_ID}.liveRotation`]: null,
                [`flags.${MODULE_ID}.sessionId`]: update.sessionId
            }
            : {
                [`flags.${MODULE_ID}.liveRotation`]: update.rotation,
                [`flags.${MODULE_ID}.sessionId`]: update.sessionId
            };

        // Продлеваем только срок уже существующей блокировки, не перезаписывая
        // userId и sessionId. Поэтому долгое вращение не потеряет владельца.
        changes[`flags.${MODULE_ID}.pilotLock.expiresAt`] = Date.now() + PILOT_LOCK_TIMEOUT;

        // await ждёт подтверждения Foundry. Блок finally выполнится и при успехе,
        // и при ошибке, поэтому очередь не останется навсегда заблокированной.
        await update.token.document.update(
            changes,
            {
                animate: false,
                [MODULE_ID]: {
                    rotation: update.rotation,
                    final: update.final,
                    sessionId: update.sessionId
                }
            }
        );

        // Блокировка снимается только после подтверждённого сохранения финала.
        // Поэтому следующий пилот начнёт уже от актуального rotation.
        if (update.final) await releasePilotLock(update.token, update.sessionId);
    } catch (error) {
        console.error(`${MODULE_ID} | Не удалось передать поворот токена`, error);
    } finally {
        networkUpdateInFlight = false;

        // Локальная картинка управляется указателем каждый кадр. Возвращаем ей
        // наиболее свежий угол после ответа Foundry, который мог применить
        // более старое промежуточное значение документа.
        const liveRotation = getLiveTokenRotation(update.token);
        if (liveRotation !== null) setTokenVisualRotation(update.token, liveRotation);

        if (pendingTokenUpdates.length) flushTokenDocumentUpdate();
    }
}

function getLiveTokenRotation(token) {
    // Пока пользователь или инерция продолжают движение, документ может хранить
    // более старое значение. Эта функция возвращает самый свежий локальный угол.
    if (activeToken === token && activeTokenRotation !== null) return activeTokenRotation;
    if (inertiaToken === token && inertiaTokenRotation !== null) return inertiaTokenRotation;
    return null;
}

// Создаёт данные временного владельца штурвала. sessionId отличает два
// последовательных захвата одного и того же пользователя.
function createPilotLock(sessionId) {
    return {
        userId: game.user.id,
        sessionId,
        expiresAt: Date.now() + PILOT_LOCK_TIMEOUT
    };
}

// Просроченный флаг не мешает новому игроку забрать управление.
function isPilotLockActive(lock) {
    return Boolean(
        lock?.userId &&
        lock?.sessionId &&
        Number.isFinite(lock.expiresAt) &&
        lock.expiresAt > Date.now()
    );
}

async function releasePilotLock(token, sessionId) {
    if (!token || !sessionId) return;

    // Не удаляем чужую или уже заменённую блокировку.
    const lock = token.document.getFlag(MODULE_ID, "pilotLock");
    if (lock?.userId !== game.user.id || lock?.sessionId !== sessionId) return;

    try {
        await token.document.update({
            [`flags.${MODULE_ID}.pilotLock`]: null
        });
    } catch (error) {
        // Даже при сетевой ошибке флаг освободится по expiresAt.
        console.error(`${MODULE_ID} | Не удалось снять блокировку токена`, error);
    }
}

function abortLocalRotationForPilotLock() {
    const lostToken = activeToken ?? inertiaToken;
    const lostSessionId = rotationSessionId;

    if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);

    inertiaFrame = null;
    inertiaToken = null;
    inertiaTokenRotation = null;
    inertiaLastTime = null;
    wheelVelocity = 0;

    interactionMode = null;
    activePointerId = null;
    activeToken = null;
    activeTokenRotation = null;
    lastAngle = null;
    lastMoveTime = null;
    rotationSessionId = null;

    // Не отправляем оставшиеся в очереди углы сессии, которая потеряла право
    // управления. Уже выполняющийся запрос отменить нельзя, но очередь очищается.
    for (let index = pendingTokenUpdates.length - 1; index >= 0; index--) {
        const pending = pendingTokenUpdates[index];
        if (pending.token === lostToken && pending.sessionId === lostSessionId) {
            pendingTokenUpdates.splice(index, 1);
        }
    }

    if (wheelBodyElement) wheelBodyElement.style.cursor = "grab";
}

function applyRemoteRotation(token, rotation, final, continuous, sessionId) {
    if (!Number.isFinite(rotation)) return;

    // mesh хранит угол в радианах, остальная логика модуля — в градусах.
    const now = performance.now();
    const visualRotation = token.mesh.rotation * 180 / Math.PI;
    const existing = remoteRotations.get(token.id);
    const current = existing?.current ?? visualRotation;
    // Углы одной сессии можно складывать непрерывно: 350°, 370°, 390°.
    // Для новой сессии выбираем кратчайший переход от текущего изображения,
    // чтобы новый захват не вызывал случайный полный оборот.
    const sameSession = existing && (!sessionId || existing.sessionId === sessionId);
    const target = sameSession
        ? existing.target + (
            continuous && existing.continuous
                ? rotation - existing.sourceRotation
                : normalizeDegreesDelta(rotation - existing.sourceRotation)
        )
        : current + normalizeDegreesDelta(rotation - current);

    // Финальное обновление rotation уже могло изменить mesh. Возвращаем
    // текущую интерполированную позицию до следующей отрисовки браузера.
    if (existing) setTokenVisualRotation(token, current);

    remoteRotations.set(token.id, {
        token,
        current,
        target,
        sourceRotation: rotation,
        continuous,
        sessionId,
        final,
        lastTime: now,
        receivedAt: now
    });

    // Некоторые обновления Placeable Foundry применяются после updateToken.
    // Повторяем восстановление в микрозадаче, всё ещё до показа кадра.
    queueMicrotask(() => {
        const state = remoteRotations.get(token.id);
        if (state) setTokenVisualRotation(state.token, state.current);
    });

    startRemoteAnimation();
}

function startRemoteAnimation() {
    // Для всех удалённых токенов достаточно одного общего цикла кадров.
    if (remoteAnimationFrame !== null) return;

    const animate = (now) => {
        for (const [tokenId, state] of remoteRotations) {
            if (!state.token?.mesh) {
                remoteRotations.delete(tokenId);
                continue;
            }

            const elapsed = Math.min(now - state.lastTime, 100);
            state.lastTime = now;
            // Экспоненциальная интерполяция каждый кадр приближает current к target.
            // Формула учитывает elapsed, поэтому плавность не зависит от FPS.
            const blend = 1 - Math.exp(-elapsed / REMOTE_SMOOTHING_TIME);
            state.current += (state.target - state.current) * blend;
            setTokenVisualRotation(state.token, state.current);

            // После достижения финального угла удаляем состояние из Map.
            // Для незавершённого движения есть запасной таймаут: он не позволяет
            // бесконечно держать анимацию, если финальный пакет потерялся.
            if (state.final && Math.abs(state.target - state.current) < 0.05) {
                setTokenVisualRotation(state.token, state.target);
                remoteRotations.delete(tokenId);
            } else if (!state.final && now - state.receivedAt > 500 && Math.abs(state.target - state.current) < 0.05) {
                remoteRotations.delete(tokenId);
            }
        }

        if (remoteRotations.size) {
            remoteAnimationFrame = requestAnimationFrame(animate);
        } else {
            remoteAnimationFrame = null;
        }
    };

    remoteAnimationFrame = requestAnimationFrame(animate);
}

function setTokenVisualRotation(token, rotation) {
    // PIXI/Foundry использует радианы: градусы × π / 180.
    if (token?.mesh) token.mesh.rotation = rotation * Math.PI / 180;
}

function addSoundMovement(deltaDegrees) {
    // Накапливаем абсолютный путь, поэтому звук одинаково работает при
    // вращении по и против часовой стрелки.
    soundAccumulator += Math.abs(deltaDegrees);
    const now = performance.now();

    if (
        !soundTemplate ||
        soundAccumulator < SOUND_STEP ||
        now - lastSoundTime < MIN_SOUND_INTERVAL
    ) return;

    lastSoundTime = now;
    soundAccumulator %= SOUND_STEP;

    // Новый экземпляр позволяет следующему щелчку начаться до конца предыдущего.
    const clickSound = soundTemplate.cloneNode();
    clickSound.volume = SOUND_VOLUME_MIN + Math.random() * SOUND_VOLUME_RANGE;
    clickSound.play().catch(() => {});
}

function getWheelCenter() {
    // getBoundingClientRect возвращает положение элемента относительно окна.
    const rect = wheelElement.getBoundingClientRect();
    return {
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2
    };
}

function normalizeRadians(value) {
    // atan2 работает в диапазоне -π…+π. При пересечении границы обычная разница
    // почти равна полному обороту; здесь превращаем её в маленький реальный шаг.
    if (value > Math.PI) return value - Math.PI * 2;
    if (value < -Math.PI) return value + Math.PI * 2;
    return value;
}

function normalizeDegrees(value) {
    // Приводим любой угол (например 725° или -10°) к диапазону 0…360°,
    // который ожидает поле rotation документа Foundry.
    return ((value % 360) + 360) % 360;
}

function normalizeDegreesDelta(value) {
    // Приводим разницу углов к диапазону -180…+180°, то есть выбираем
    // кратчайшее направление поворота.
    return ((value + 180) % 360 + 360) % 360 - 180;
}

function clamp(value, minimum, maximum) {
    // Универсальное ограничение числа заданным диапазоном.
    return Math.min(maximum, Math.max(minimum, value));
}

// Основные DOM-элементы штурвала.
// wheelElement — общий контейнер.
// wheelBodyElement — сама картинка штурвала.
// handleElement — прозрачная зона в центре для перетаскивания.
let wheelElement = null;
let wheelBodyElement = null;
let handleElement = null;

// Настройки звука.
// soundAccumulator копит пройденные градусы,
// чтобы щелчок звучал не каждый кадр, а через soundStep градусов.
let wheelSound = null;
let soundAccumulator = 0;
let soundStep = 60;
let lastSoundTime = 0;
let minSoundInterval = 60;

// Настройки звука щелчков.
let soundVolumeMin = 0.05;  // исходная громкость
let soundVolumeRange = 0.2; // разброс

// Режимы взаимодействия мышью.
// В каждый момент активен либо перенос, либо вращение, либо изменение размера.
let isDragging = false;
let isRotating = false;
let isResizing = false;

// Положение и размер штурвала на экране.
let wheelSize = 180;
let wheelX = 100;
let wheelY = 100;

// Смещение курсора относительно штурвала во время перетаскивания.
let offsetX = 0;
let offsetY = 0;

// Последний угол курсора относительно центра штурвала.
// Используется для вычисления поворота между кадрами.
let lastAngle = null;

// Временный угол поворота выбранного токена.
// Пока игрок крутит штурвал, меняем только отображение токена,
// а итоговое значение сохраняем после отпускания мыши.
let controlledTokenRotation = null;

// Не позволяет спамить предупреждением,
// если игрок пытается крутить штурвал без выделенного токена.
let warnedNoToken = false;

// Данные вращения штурвала.
// wheelRotation — текущий угол картинки.
// wheelVelocity — скорость, которая используется для инерции.
let wheelRotation = 0;
let wheelVelocity = 0;

let inertiaFrame = null;

// Токен, который продолжает вращаться вместе со штурвалом во время инерции.
let inertiaToken = null;
let inertiaTokenRotation = null;

// На сколько уменьшается скорость инерции каждый кадр.
let inertiaDeceleration = 0.06;
// Порог скорости, ниже которого инерция считается завершённой.
let inertiaStopSpeed = 0.2;


// --------------------------------------------------
// Кнопка модуля на панели инструментов Foundry
// --------------------------------------------------
Hooks.on("getSceneControlButtons", (controls) => {
    controls["ship-wheel"] = {
        name: "ship-wheel",
        title: "Штурвал",
        icon: "fas fa-sailboat",
        layer: "tokens",
        tools: {
            wheel: {
                name: "wheel",
                title: "Открыть штурвал",
                icon: "fas fa-dharmachakra",
                button: true,
                onClick: () => {
						// Если штурвал уже открыт — закрываем его и сбрасываем состояние.
						if (wheelElement) {
							wheelElement.remove();
							wheelElement = null;
							wheelBodyElement = null;
							handleElement = null;

							if (inertiaFrame) {
								cancelAnimationFrame(inertiaFrame);
								inertiaFrame = null;
							}

							wheelVelocity = 0;
							wheelRotation = 0;
							
							inertiaToken = null;
							inertiaTokenRotation = null;
							soundAccumulator = 0;

							isDragging = false;
							isRotating = false;
							isResizing = false;
							lastAngle = null;
							controlledTokenRotation = null;

							return;
						}
						// Если штурвала нет — создаём новый интерфейс штурвала.
						wheelElement = document.createElement("div");
						
						wheelSound = new Audio(
							"modules/ship-wheel/assets/sounds/wheel1.mp3"
						);

						wheelSound.loop = false;
						wheelSound.volume = 0.2;

						handleElement = document.createElement("div");
						wheelBodyElement = document.createElement("div");
						const resizeElement = document.createElement("div");
						
						// Прозрачная центральная область.
						// Игрок её не видит, но может схватить за центр и перетащить штурвал.
						handleElement.textContent = "";

						handleElement.style.width = (wheelSize * 0.15) + "px";
						handleElement.style.height = (wheelSize * 0.15) + "px";
						handleElement.style.borderRadius = "50%";
						handleElement.style.background = "transparent";
						handleElement.style.border = "none";
						handleElement.style.color = "black";

						handleElement.style.display = "flex";
						handleElement.style.alignItems = "center";
						handleElement.style.justifyContent = "center";
						
						handleElement.style.position = "absolute";
						handleElement.style.left = "50%";
						handleElement.style.top = "50%";
						handleElement.style.transform = "translate(-50%, -50%)";

						handleElement.style.cursor = "move";
						
						// Маленький уголок внизу справа для изменения размера штурвала.
						resizeElement.style.position = "absolute";
						resizeElement.style.right = "4px";
						resizeElement.style.bottom = "4px";

						resizeElement.style.width = "12px";
						resizeElement.style.height = "12px";
						resizeElement.style.cursor = "nwse-resize";
						resizeElement.style.zIndex = "10";

						resizeElement.style.background = "transparent";
						resizeElement.style.borderRight = "2px solid rgba(210, 170, 90, 0.8)";
						resizeElement.style.borderBottom = "2px solid rgba(210, 170, 90, 0.8)";
						resizeElement.style.filter = "drop-shadow(0 0 2px black)";

						// Контейнер штурвала: положение, размер и фиксация поверх интерфейса.
						wheelElement.style.position = "fixed";
						wheelElement.style.top = wheelY + "px";
						wheelElement.style.left = wheelX + "px";

						wheelElement.style.width = wheelSize + "px";
						wheelElement.style.height = wheelSize + "px";
						
						// Видимая часть штурвала: картинка, которая будет вращаться.
						wheelBodyElement.style.position = "absolute";
						wheelBodyElement.style.left = "0";
						wheelBodyElement.style.top = "0";

						
						wheelBodyElement.style.width = "100%";
						wheelBodyElement.style.height = "100%";

						wheelBodyElement.style.backgroundImage = "url('modules/ship-wheel/assets/wheel.webp')";
						wheelBodyElement.style.backgroundSize = "contain";
						wheelBodyElement.style.backgroundRepeat = "no-repeat";
						wheelBodyElement.style.backgroundPosition = "center";


						document.body.appendChild(wheelElement);
						wheelElement.appendChild(wheelBodyElement);
						wheelElement.appendChild(handleElement);
						wheelElement.appendChild(resizeElement);
						
						// Начало вращения.
						// Запоминаем стартовый угол мыши относительно центра штурвала.
						wheelBodyElement.addEventListener("mousedown", (event) => {
							isRotating = true;
							const token = canvas.tokens.controlled[0];
							
							if (token) {
								controlledTokenRotation = token.document.rotation;
							}

							if (!token && !warnedNoToken) {
								ui.notifications.warn("Выделите токен, который должен вращаться");
								warnedNoToken = true;
							}

							if (token) {
								warnedNoToken = false;
							}

							const rect = wheelElement.getBoundingClientRect();

							const centerX = rect.left + rect.width / 2;
							const centerY = rect.top + rect.height / 2;

							const dx = event.clientX - centerX;
							const dy = event.clientY - centerY;

							lastAngle = Math.atan2(dy, dx);
						});
						
						// Начало перетаскивания за центральную прозрачную область.
						handleElement.addEventListener("mousedown", (event) => {
							isDragging = true;

							offsetX = event.clientX - wheelElement.offsetLeft;
							offsetY = event.clientY - wheelElement.offsetTop;
						});
						
						// Начало изменения размера за уголок.
						resizeElement.addEventListener("mousedown", (event) => {
							event.stopPropagation();
							isResizing = true;
						});

					}
                }
            }
        }
    });
	
// --------------------------------------------------
// Глобальная обработка движения мыши
// Отвечает за изменение размера, вращение и перетаскивание.
// --------------------------------------------------

document.addEventListener("mousemove", (event) => {
	// Изменение размера штурвала с ограничением min/max.
	if (isResizing && wheelElement) {
		const rect = wheelElement.getBoundingClientRect();

		const newSize = Math.min(
			400,
			Math.max(
				80,
				event.clientX - rect.left
			)
		);

		wheelSize = newSize;

		wheelElement.style.width = wheelSize + "px";
		wheelElement.style.height = wheelSize + "px";

		handleElement.style.width = (wheelSize * 0.15) + "px";
		handleElement.style.height = (wheelSize * 0.15) + "px";

		return;
	}
	
	// Вращение штурвала мышью.
	if (isRotating && wheelElement) {
		const rect = wheelElement.getBoundingClientRect();

		const centerX = rect.left + rect.width / 2;
		const centerY = rect.top + rect.height / 2;

		const dx = event.clientX - centerX;
		const dy = event.clientY - centerY;

		const angle = Math.atan2(dy, dx);

		// Исправляем скачок угла при переходе через -180 / +180 градусов.
		let delta = angle - lastAngle;
		if (delta > Math.PI) {
			delta -= Math.PI * 2;
		}

		if (delta < -Math.PI) {
			delta += Math.PI * 2;
		}
		
		lastAngle = angle;

		const deltaDegrees = delta * 180 / Math.PI;
		soundAccumulator += Math.abs(deltaDegrees);

		// Щелчок звучит через каждые soundStep градусов,
		// но не чаще, чем minSoundInterval миллисекунд.
		const now = Date.now();

		if (
			wheelSound &&
			soundAccumulator >= soundStep &&
			now - lastSoundTime >= minSoundInterval
		) {
			lastSoundTime = now;

			const clickSound = new Audio(
				"modules/ship-wheel/assets/sounds/wheel1.mp3"
			);

			clickSound.volume =
				soundVolumeMin + Math.random() * soundVolumeRange;

			//clickSound.playbackRate =
			//	0.5 + Math.random();

			clickSound.play();

			soundAccumulator = 0;
		}
		
		const token = canvas.tokens.controlled[0];

		if (token) {
			// Вращаем только видимую картинку токена.
			// Документ токена сохраним позже, когда мышь отпустят.
			controlledTokenRotation += deltaDegrees;
			token.mesh.rotation = controlledTokenRotation * Math.PI / 180;
		}

		wheelRotation += deltaDegrees;
		wheelVelocity = deltaDegrees * 0.4; // тяжёлый штурвал, 0.6 мягче

		wheelBodyElement.style.transform = `rotate(${wheelRotation}deg)`;

		return;
	}
	if (!isDragging) return;

	wheelX = event.clientX - offsetX;
	wheelY = event.clientY - offsetY;

	wheelX = Math.max(
		0,
		Math.min(
			window.innerWidth - wheelElement.offsetWidth,
			wheelX
		)
	);

	wheelY = Math.max(
		0,
		Math.min(
			window.innerHeight - wheelElement.offsetHeight,
			wheelY
		)
	);

	wheelElement.style.left = wheelX + "px";
	wheelElement.style.top = wheelY + "px";
});

// --------------------------------------------------
// Отпускание мыши.
// Сохраняет итоговый угол токена и при необходимости запускает инерцию.
// --------------------------------------------------
document.addEventListener("mouseup", () => {
	const token = canvas.tokens.controlled[0];

	if (token && controlledTokenRotation !== null) {
		token.document.update(
			{
				rotation: controlledTokenRotation
			},
			{
				animate: false
			}
		);
	}
	inertiaToken = canvas.tokens.controlled[0];
	inertiaTokenRotation = controlledTokenRotation;
	if (Math.abs(wheelVelocity) > inertiaStopSpeed) {
		startInertia();
	}
	isRotating = false;
	isDragging = false;
	lastAngle = null;
	controlledTokenRotation = null;
	isResizing = false;
	soundAccumulator = 0;
});

// --------------------------------------------------
// Инерция штурвала
// После отпускания мыши штурвал продолжает вращаться,
// постепенно теряя скорость. Токен и звук следуют за инерцией.
// --------------------------------------------------
function startInertia() {
	if (inertiaFrame) {
		cancelAnimationFrame(inertiaFrame);
	}


	function animateInertia() {
		if (!wheelElement) {
			inertiaFrame = null;
			return;
		}
		
		// Линейно уменьшаем скорость вращения каждый кадр.
		wheelVelocity = wheelVelocity * 0.995;

		if (Math.abs(wheelVelocity) < 0.05) {
			wheelVelocity *= 0.85;
		}
		
		// Если скорость стала слишком маленькой — останавливаем инерцию
		// и сохраняем финальный угол токена без анимации Foundry.	
		if (Math.abs(wheelVelocity) < inertiaStopSpeed) {
			if (inertiaToken && inertiaTokenRotation !== null) {
				inertiaToken.document.update(
					{
						rotation: inertiaTokenRotation
					},
					{
						animate: false
					}
				);
			}

			inertiaToken = null;
			inertiaTokenRotation = null;
			inertiaFrame = null;
			return;
		}

		wheelRotation += wheelVelocity;
		
		soundAccumulator += Math.abs(wheelVelocity);

		const now = Date.now();

		if (
			wheelSound &&
			soundAccumulator >= soundStep &&
			now - lastSoundTime >= minSoundInterval
		) {
			lastSoundTime = now;

			const clickSound = new Audio(
				"modules/ship-wheel/assets/sounds/wheel1.mp3"
			);

			clickSound.volume =
				soundVolumeMin + Math.random() * soundVolumeRange;

			//clickSound.playbackRate =
			//	0.5 + Math.random();

			clickSound.play();

			soundAccumulator = 0;
		}

		wheelBodyElement.style.transform =
			`rotate(${wheelRotation}deg)`;
			if (inertiaToken && inertiaTokenRotation !== null) {
					inertiaTokenRotation += wheelVelocity;

					inertiaToken.mesh.rotation =
						inertiaTokenRotation * Math.PI / 180;
				}

		inertiaFrame = requestAnimationFrame(animateInertia);
	}

	inertiaFrame = requestAnimationFrame(animateInertia);
}
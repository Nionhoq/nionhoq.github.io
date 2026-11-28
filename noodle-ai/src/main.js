const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

// Staggered headline reveal; the un-split heading remains readable without JavaScript.
$$('[data-split]').forEach((line, lineIndex) => {
  const text = line.textContent;
  line.textContent = '';
  const accessible = document.createElement('span');
  accessible.className = 'sr-only';
  accessible.textContent = text;
  const visual = document.createElement('span');
  visual.setAttribute('aria-hidden', 'true');
  [...text].forEach((character, characterIndex) => {
    const span = document.createElement('span');
    span.className = 'char';
    span.textContent = character;
    span.style.setProperty('--char-index', characterIndex + lineIndex * 3);
    visual.appendChild(span);
  });
  line.append(accessible, visual);
  line.classList.add('is-split');
});
requestAnimationFrame(() => {
  requestAnimationFrame(() => $$('[data-split]').forEach(line => line.classList.add('is-in')));
});

// Noodle's dimensional stage and pointer/touch following.
const hero = $('.hero');
const stage = $('#stage');
const stageTilt = $('#stageTilt');
const catMotion = $('#catMotion');
const noodle = $('#noodle');
const catButton = $('#catButton');
const bubble = $('#bubble');
let targetX = 0;
let targetY = 0;
let currentX = 0;
let currentY = 0;
let heroVisible = true;
let bubbleTimer;

function say(message, duration = 3800) {
  bubble.textContent = message;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), duration);
}

function hop(strong = false) {
  if (reduceMotion.matches) return;
  const height = strong ? -30 : -18;
  noodle.animate([
    { transform: 'translateY(0) rotate(0deg) scale(1)' },
    { transform: `translateY(${height}px) rotate(-3deg) scale(1.02)`, offset: 0.38 },
    { transform: 'translateY(0) rotate(2deg) scale(.98,1.02)', offset: 0.72 },
    { transform: 'translateY(0) rotate(0deg) scale(1)' }
  ], { duration: 520, easing: 'cubic-bezier(.19,1,.22,1)' });
}

function moveNoodle(event) {
  const rect = stage.getBoundingClientRect();
  targetX = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)));
  targetY = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)));
}
hero.addEventListener('pointermove', moveNoodle, { passive: true });
hero.addEventListener('pointerleave', () => { targetX = 0; targetY = 0; });
new IntersectionObserver(([entry]) => { heroVisible = entry.isIntersecting; }).observe(hero);

function animateStage() {
  if (!reduceMotion.matches && heroVisible && !document.hidden) {
    currentX += (targetX - currentX) * 0.085;
    currentY += (targetY - currentY) * 0.085;
    stageTilt.style.setProperty('--tilt-x', `${-currentY * 4.5}deg`);
    stageTilt.style.setProperty('--tilt-y', `${currentX * 6.5}deg`);
    catMotion.style.setProperty('--cat-x', `${currentX * 19}px`);
    catMotion.style.setProperty('--cat-y', `${currentY * 10}px`);
    catMotion.style.setProperty('--cat-r', `${currentX * 3.5}deg`);
  }
  requestAnimationFrame(animateStage);
}
requestAnimationFrame(animateStage);

const facts = [
  'AI learns from examples—the way I learned the treat cupboard sound.',
  'A prompt is just instructions. Clear instructions, better answers.',
  'AI can be confident and wrong at the same time. Check the important stuff.',
  'Your brain updates with practice. Models learn from examples too.',
  'Small steps every day beat one giant leap. For cats and for AI.',
  'Data is a big pile of examples. Good examples teach good habits.'
];
let factIndex = 0;
catButton.addEventListener('click', () => {
  say(facts[factIndex % facts.length], 4400);
  factIndex += 1;
  hop();
});

const outfits = [
  { src: 'assets/noodle-1.webp', alt: 'Noodle, a grey tabby cat in a black beanie and orange hoodie', line: 'Orange hoodie. Classic curiosity.' },
  { src: 'assets/noodle-2.webp', alt: 'Noodle, a grey tabby cat in a black beanie and sage cardigan', line: 'Sage cardigan. Very scholarly.' },
  { src: 'assets/noodle-3.webp', alt: 'Noodle, a grey tabby cat in a black beanie and paint-splashed overalls', line: 'Overalls! Ready to make things.' },
  { src: 'assets/noodle-4.webp', alt: 'Noodle, a grey tabby cat in a black beanie and teal track jacket', line: 'Track jacket. Fast thoughts only.' }
];
let outfitIndex = 0;
$('#outfitBtn').addEventListener('click', () => {
  outfitIndex = (outfitIndex + 1) % outfits.length;
  const outfit = outfits[outfitIndex];
  noodle.src = outfit.src;
  noodle.alt = outfit.alt;
  say(outfit.line);
  if (!reduceMotion.matches) {
    noodle.animate([
      { transform: 'scale(.82) rotate(-7deg)', opacity: .35 },
      { transform: 'scale(1.04) rotate(3deg)', opacity: 1, offset: .65 },
      { transform: 'scale(1) rotate(0deg)', opacity: 1 }
    ], { duration: 480, easing: 'cubic-bezier(.19,1,.22,1)' });
  }
});

// Treats are real DOM/SVG objects with a curved flight path.
let treats = 0;
const treatCount = $('#treatCount');
function updateTreats() {
  treatCount.textContent = treats;
  if (!reduceMotion.matches) {
    treatCount.animate([
      { transform: 'scale(.7) rotate(-12deg)' },
      { transform: 'scale(1.25) rotate(8deg)', offset: .6 },
      { transform: 'scale(1) rotate(0)' }
    ], { duration: 360, easing: 'ease-out' });
  }
}
function finishTreat() {
  treats += 1;
  updateTreats();
  const messages = [
    'A treat! You are my favourite human today.',
    'Another treat! My brain is doing the happy update.',
    'Excellent pattern detected: you + treats = happy cat.'
  ];
  say(messages[(treats - 1) % messages.length]);
  hop(true);
}
$('#treatBtn').addEventListener('click', event => {
  if (reduceMotion.matches || !Element.prototype.animate) {
    finishTreat();
    return;
  }
  const from = event.currentTarget.getBoundingClientRect();
  const to = noodle.getBoundingClientRect();
  const startX = from.left + from.width / 2;
  const startY = from.top + from.height / 2;
  const dx = to.left + to.width * .53 - startX;
  const dy = to.top + to.height * .37 - startY;
  const flyingTreat = document.createElement('div');
  flyingTreat.className = 'flying-treat';
  flyingTreat.style.left = `${startX}px`;
  flyingTreat.style.top = `${startY}px`;
  flyingTreat.innerHTML = '<svg viewBox="0 0 28 28"><path d="M5 14c4-7 11-7 15 0-4 7-11 7-15 0Z"/><path d="m20 14 5-5v10zM9 11h.01"/></svg>';
  document.body.appendChild(flyingTreat);
  const flight = flyingTreat.animate([
    { transform: 'translate(-50%,-50%) rotate(0deg) scale(.65)', opacity: 0 },
    { transform: `translate(calc(-50% + ${dx * .25}px),calc(-50% + ${dy * .25 - 90}px)) rotate(100deg) scale(1.05)`, opacity: 1, offset: .35 },
    { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) rotate(330deg) scale(.35)`, opacity: 1 }
  ], { duration: 680, easing: 'cubic-bezier(.3,.7,.3,1)' });
  flight.onfinish = () => { flyingTreat.remove(); finishTreat(); };
  flight.oncancel = () => flyingTreat.remove();
});

setTimeout(() => say('Psst. Move around. I follow.'), reduceMotion.matches ? 0 : 700);

// Scroll-linked color rooms and gentle parallax layers.
const themedSections = $$('[data-theme]');
const parallaxItems = $$('[data-speed]');
const themeColors = { forest: '#178255', sage: '#D4D4C6', peach: '#E9A98F', beige: '#D1BDAB' };
let scrollTicking = false;
function updateScrollEffects() {
  scrollTicking = false;
  const marker = window.innerHeight * .52;
  let activeTheme = 'forest';
  themedSections.forEach(section => {
    const rect = section.getBoundingClientRect();
    if (rect.top <= marker && rect.bottom >= marker) activeTheme = section.dataset.theme;
  });
  if (document.body.dataset.theme !== activeTheme) {
    document.body.dataset.theme = activeTheme;
    $('meta[name="theme-color"]').content = themeColors[activeTheme];
  }
  if (!reduceMotion.matches) {
    parallaxItems.forEach(item => {
      const rect = item.getBoundingClientRect();
      if (rect.bottom < -150 || rect.top > window.innerHeight + 150) return;
      const distance = window.innerHeight / 2 - (rect.top + rect.height / 2);
      const y = Math.max(-55, Math.min(55, distance * Number(item.dataset.speed)));
      item.style.setProperty('--parallax-y', `${y}px`);
    });
  }
}
function requestScrollUpdate() {
  if (!scrollTicking) {
    scrollTicking = true;
    requestAnimationFrame(updateScrollEffects);
  }
}
window.addEventListener('scroll', requestScrollUpdate, { passive: true });
window.addEventListener('resize', requestScrollUpdate);
reduceMotion.addEventListener('change', requestScrollUpdate);
updateScrollEffects();

// Three-dimensional, keyboard-operable lesson deck.
const lessonCards = $$('.lesson-card');
const lessonDots = $$('[data-goto-lesson]');
const lessonPrev = $('#lessonPrev');
const lessonNext = $('#lessonNext');
const lessonBubble = $('#lessonBubble');
const lessonLines = ['Goal + context + format.', 'Good examples teach good habits.', 'Pause, check, then pounce.'];
let lessonIndex = 0;
function showLesson(index) {
  lessonIndex = Math.max(0, Math.min(lessonCards.length - 1, index));
  lessonCards.forEach((card, i) => {
    card.classList.remove('is-active', 'is-next', 'is-prev');
    if (i === lessonIndex) card.classList.add('is-active');
    else if (i === lessonIndex + 1) card.classList.add('is-next');
    else if (i === lessonIndex - 1) card.classList.add('is-prev');
    card.setAttribute('aria-hidden', String(i !== lessonIndex));
  });
  lessonDots.forEach((dot, i) => {
    dot.classList.toggle('is-active', i === lessonIndex);
    if (i === lessonIndex) dot.setAttribute('aria-current', 'true');
    else dot.removeAttribute('aria-current');
  });
  lessonPrev.disabled = lessonIndex === 0;
  lessonNext.disabled = lessonIndex === lessonCards.length - 1;
  lessonBubble.textContent = lessonLines[lessonIndex];
}
lessonPrev.addEventListener('click', () => showLesson(lessonIndex - 1));
lessonNext.addEventListener('click', () => showLesson(lessonIndex + 1));
lessonDots.forEach(dot => dot.addEventListener('click', () => showLesson(Number(dot.dataset.gotoLesson))));
$('.lesson-experience').addEventListener('keydown', event => {
  if (event.key === 'ArrowRight') { event.preventDefault(); showLesson(lessonIndex + 1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); showLesson(lessonIndex - 1); }
});
showLesson(0);

// Treat quiz with instant feedback, celebrations, and a complete/restart state.
const questions = [
  { q: 'What does AI learn from?', options: ['Examples and data', 'Magic spells', 'The weather'], answer: 0 },
  { q: 'What is a prompt?', options: ['A type of cat food', 'Instructions you give an AI', 'A computer brand'], answer: 1 },
  { q: 'Can AI make mistakes?', options: ['Never', 'Only on Mondays', 'Yes, so we check important answers'], answer: 2 }
];
const quizOptions = $('#quizOptions');
const quizQuestion = $('#quizQuestion');
const quizFeedback = $('#quizFeedback');
const quizStep = $('#quizStep');
const quizScore = $('#quizScore');
const quizProgress = $('#quizProgress');
const nextQuestion = $('#nextQuestion');
const quizLive = $('#quizLive');
const quizComplete = $('#quizComplete');
const quizReaction = $('#quizReaction');
let questionIndex = 0;
let score = 0;
let answered = false;

function celebrate() {
  if (!reduceMotion.matches) {
    $('#quizCat').animate([
      { transform: 'translateY(0) rotate(0)' },
      { transform: 'translateY(-24px) rotate(-5deg)', offset: .4 },
      { transform: 'translateY(0) rotate(4deg)', offset: .75 },
      { transform: 'translateY(0) rotate(0)' }
    ], { duration: 520, easing: 'cubic-bezier(.19,1,.22,1)' });
    const colors = ['#178255', '#E9A98F', '#D4D4C6', '#C96A24', '#ECDDC1'];
    for (let i = 0; i < 20; i += 1) {
      const piece = document.createElement('span');
      piece.className = 'confetti';
      piece.style.setProperty('--confetti-color', colors[i % colors.length]);
      $('#confettiLayer').appendChild(piece);
      const x = (Math.random() - .5) * 440;
      const y = -80 - Math.random() * 220;
      const spin = Math.random() * 720 - 360;
      const burst = piece.animate([
        { transform: 'translate(0,0) rotate(0deg) scale(.6)', opacity: 1 },
        { transform: `translate(${x * .75}px,${y}px) rotate(${spin}deg) scale(1)`, opacity: 1, offset: .55 },
        { transform: `translate(${x}px,240px) rotate(${spin * 1.5}deg) scale(.8)`, opacity: 0 }
      ], { duration: 950 + Math.random() * 350, easing: 'cubic-bezier(.2,.7,.3,1)' });
      burst.onfinish = () => piece.remove();
    }
  }
}

function renderQuestion() {
  answered = false;
  const item = questions[questionIndex];
  quizQuestion.textContent = item.q;
  quizStep.textContent = `Question ${questionIndex + 1} of ${questions.length}`;
  quizProgress.style.width = `${((questionIndex + 1) / questions.length) * 100}%`;
  quizFeedback.textContent = 'Pick the answer you think is right.';
  nextQuestion.hidden = true;
  quizOptions.textContent = '';
  item.options.forEach((option, optionIndex) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiz-option';
    button.dataset.letter = String.fromCharCode(65 + optionIndex);
    button.textContent = option;
    button.addEventListener('click', () => answerQuestion(optionIndex, button));
    quizOptions.appendChild(button);
  });
}

function answerQuestion(optionIndex, selectedButton) {
  if (answered) return;
  answered = true;
  const item = questions[questionIndex];
  const buttons = $$('.quiz-option', quizOptions);
  buttons.forEach(button => { button.disabled = true; });
  buttons[item.answer].classList.add('is-correct');
  const correct = optionIndex === item.answer;
  if (correct) {
    score += 1;
    quizScore.textContent = score;
    treats += 1;
    updateTreats();
    quizFeedback.textContent = 'Correct! One treat earned. Noodle is extremely impressed.';
    quizReaction.textContent = ['Treat-worthy answer!', 'You cracked the pattern!', 'Smart human. Great pounce!'][questionIndex];
    celebrate();
  } else {
    selectedButton.classList.add('is-wrong');
    quizFeedback.textContent = `Not quite. “${item.options[item.answer]}” is the right answer. That’s how learning happens!`;
    quizReaction.textContent = 'Good try. Brains learn by updating!';
  }
  nextQuestion.textContent = questionIndex === questions.length - 1 ? 'See my score' : 'Next question';
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.setAttribute('viewBox', '0 0 20 20');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.innerHTML = '<path d="m7 4 6 6-6 6"/>';
  nextQuestion.appendChild(arrow);
  nextQuestion.hidden = false;
}

nextQuestion.addEventListener('click', () => {
  if (questionIndex < questions.length - 1) {
    questionIndex += 1;
    renderQuestion();
    quizQuestion.focus({ preventScroll: true });
  } else {
    quizLive.hidden = true;
    quizComplete.hidden = false;
    quizStep.textContent = 'Quiz complete';
    quizProgress.style.width = '100%';
    $('#completeTitle').textContent = score === 3 ? 'A perfect treat bag!' : score === 2 ? 'Treat-worthy thinking!' : 'Curiosity wins!';
    $('#completeMessage').textContent = `You scored ${score} out of ${questions.length}. ${score === 3 ? 'Noodle is doing the full happy tail dance.' : 'Every answer teaches something new. Noodle says: keep that curiosity switched on.'}`;
    quizReaction.textContent = score === 3 ? 'Three treats. Zero notes.' : 'You showed up and learned!';
    celebrate();
  }
});

$('#restartQuiz').addEventListener('click', () => {
  questionIndex = 0;
  score = 0;
  quizScore.textContent = '0';
  quizComplete.hidden = true;
  quizLive.hidden = false;
  quizReaction.textContent = 'One more pounce?';
  renderQuestion();
});

renderQuestion();

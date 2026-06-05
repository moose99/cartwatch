// Bricks: a self-contained Breakout-style game using only public-domain mechanics.

(function () {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Brick layout constants
  const BRICK_ROWS = 5;
  const BRICK_COLS = 8;
  const BRICK_TOP = 40;
  const BRICK_SIDE_PAD = 12;
  const BRICK_GAP = 4;
  const BRICK_H = 14;
  // Row colors cycle from top (highest value) to bottom
  const ROW_COLORS = ['#FF9900', '#e85a2b', '#c44569', '#6c5ce7', '#3a86ff'];

  const PADDLE_W = 64;
  const PADDLE_H = 8;
  const PADDLE_Y = H - 28;
  const BALL_R = 5;
  const BASE_SPEED = 3.2;

  const state = {
    paddleX: (W - PADDLE_W) / 2,
    ball: { x: 0, y: 0, vx: 0, vy: 0, stuck: true },
    bricks: [],
    score: 0,
    best: 0,
    lives: 3,
    level: 1,
    running: false,
    speed: BASE_SPEED,
  };

  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const livesEl = document.getElementById('lives');
  const levelEl = document.getElementById('level');

  // Persistent high score lives in chrome.storage.local under bricksHighScore.
  function loadHighScore() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ bricksHighScore: 0 }, data => {
        state.best = data.bricksHighScore || 0;
        bestEl.textContent = state.best;
      });
    }
  }
  function saveHighScore() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ bricksHighScore: state.best }, () => { void chrome.runtime?.lastError; });
    }
  }
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayText = document.getElementById('overlay-text');
  const playBtn = document.getElementById('play-btn');

  function buildBricks() {
    const grid = [];
    const usable = W - BRICK_SIDE_PAD * 2 - BRICK_GAP * (BRICK_COLS - 1);
    const bw = usable / BRICK_COLS;
    for (let r = 0; r < BRICK_ROWS; r++) {
      for (let c = 0; c < BRICK_COLS; c++) {
        grid.push({
          x: BRICK_SIDE_PAD + c * (bw + BRICK_GAP),
          y: BRICK_TOP + r * (BRICK_H + BRICK_GAP),
          w: bw,
          h: BRICK_H,
          color: ROW_COLORS[r % ROW_COLORS.length],
          points: (BRICK_ROWS - r) * 10,
          alive: true,
        });
      }
    }
    state.bricks = grid;
  }

  function resetBallToPaddle() {
    state.ball.x = state.paddleX + PADDLE_W / 2;
    state.ball.y = PADDLE_Y - BALL_R - 1;
    state.ball.vx = 0;
    state.ball.vy = 0;
    state.ball.stuck = true;
  }

  function launchBall() {
    if (!state.ball.stuck) return;
    state.ball.stuck = false;
    // angle between -60 and -120 degrees (mostly up, slight L/R)
    const angle = (-90 + (Math.random() * 60 - 30)) * Math.PI / 180;
    state.ball.vx = Math.cos(angle) * state.speed;
    state.ball.vy = Math.sin(angle) * state.speed;
  }

  function newGame() {
    state.score = 0;
    state.lives = 3;
    state.level = 1;
    state.speed = BASE_SPEED;
    // remember the best score from when this game started so we can show "New
    // best!" at the end even though state.best is updated live during play.
    state.bestAtStart = state.best;
    buildBricks();
    resetBallToPaddle();
    state.running = true;
    overlay.classList.add('hidden');
    updateHud();
  }

  function nextLevel() {
    state.level++;
    state.speed = Math.min(BASE_SPEED + (state.level - 1) * 0.5, 7);
    buildBricks();
    resetBallToPaddle();
    updateHud();
  }

  function gameOver() {
    state.running = false;
    // Best is already updated and saved live during play - just decide whether
    // this game beat the previous best to show the "New best!" message.
    const newBest = state.score > (state.bestAtStart ?? 0);
    overlayTitle.textContent = 'Game Over';
    const bestLine = newBest
      ? `<span style="color:#FF9900">New best!</span> ${state.score}`
      : `Final score: <strong>${state.score}</strong><br>Best: ${state.best}`;
    overlayText.innerHTML = bestLine;
    playBtn.textContent = 'Play Again';
    overlay.classList.remove('hidden');
  }

  function updateHud() {
    scoreEl.textContent = state.score;
    bestEl.textContent = state.best;
    livesEl.textContent = state.lives;
    levelEl.textContent = state.level;
  }

  function update() {
    if (!state.running) return;

    if (state.ball.stuck) {
      state.ball.x = state.paddleX + PADDLE_W / 2;
      state.ball.y = PADDLE_Y - BALL_R - 1;
      return;
    }

    const b = state.ball;
    b.x += b.vx;
    b.y += b.vy;

    // wall collisions
    if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = -b.vx; }
    if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -b.vx; }
    if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = -b.vy; }

    // paddle collision
    if (b.vy > 0 && b.y + BALL_R >= PADDLE_Y && b.y - BALL_R <= PADDLE_Y + PADDLE_H
        && b.x >= state.paddleX && b.x <= state.paddleX + PADDLE_W) {
      // angle depends on where the ball hits the paddle
      const hit = (b.x - state.paddleX) / PADDLE_W; // 0..1
      const angle = (-150 + hit * 120) * Math.PI / 180; // -150 to -30 deg
      const speed = Math.hypot(b.vx, b.vy);
      b.vx = Math.cos(angle) * speed;
      b.vy = Math.sin(angle) * speed;
      b.y = PADDLE_Y - BALL_R - 1;
    }

    // brick collisions
    for (const brick of state.bricks) {
      if (!brick.alive) continue;
      if (b.x + BALL_R < brick.x || b.x - BALL_R > brick.x + brick.w
          || b.y + BALL_R < brick.y || b.y - BALL_R > brick.y + brick.h) continue;
      brick.alive = false;
      state.score += brick.points;
      // bump the high score live so the player sees Best climb as they pass it
      if (state.score > state.best) {
        state.best = state.score;
        saveHighScore();
      }
      // pick axis of bounce based on entry side
      const prevX = b.x - b.vx;
      const prevY = b.y - b.vy;
      const fromSide = prevX + BALL_R < brick.x || prevX - BALL_R > brick.x + brick.w;
      const fromTopBot = prevY + BALL_R < brick.y || prevY - BALL_R > brick.y + brick.h;
      if (fromSide && !fromTopBot) b.vx = -b.vx;
      else if (fromTopBot && !fromSide) b.vy = -b.vy;
      else { b.vx = -b.vx; b.vy = -b.vy; }
      updateHud();
      break;
    }

    // ball fell below paddle
    if (b.y - BALL_R > H) {
      state.lives--;
      updateHud();
      if (state.lives <= 0) {
        gameOver();
        return;
      }
      resetBallToPaddle();
    }

    // level cleared
    if (state.bricks.every(br => !br.alive)) {
      nextLevel();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // bricks
    for (const brick of state.bricks) {
      if (!brick.alive) continue;
      ctx.fillStyle = brick.color;
      ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
    }

    // paddle
    ctx.fillStyle = '#FF9900';
    ctx.fillRect(state.paddleX, PADDLE_Y, PADDLE_W, PADDLE_H);

    // ball
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(state.ball.x, state.ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // input
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    state.paddleX = Math.max(0, Math.min(W - PADDLE_W, x - PADDLE_W / 2));
  });
  canvas.addEventListener('mousedown', () => {
    if (state.running) launchBall();
  });

  playBtn.addEventListener('click', () => {
    newGame();
  });

  // initial draw + intro overlay
  loadHighScore();
  resetBallToPaddle();
  draw();
  loop();
})();

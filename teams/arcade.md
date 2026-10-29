---
name: arcade
description: Games and interactive simulations — four seats tuned for core-loop feel, deterministic statecharts, frame pacing, and full-match playtesting.
---

# Arcade

Product: Core-loop juice, instant HUD legibility, clear stakes, and zero menu ceremony before play starts. Every action needs immediate visual feedback and a reason to play one more round.

Architect: Deterministic tick and seed discipline, complete statecharts (attract, countdown, active play, pause, game-over, rematch), and authoritative turn/duel sync with zero ambient time or randomness.

Engineer: Frame-rate budget first, responsive keyboard and touch controls, and unmistakable visual rendering for every board or arena state. Never ship two game states that draw the same pixels.

QA: Play full rounds to win, loss, and timeout across desktop and mobile touch viewports. Compare live frame captures across state transitions to prove every move, collision, or score change is visibly distinct.

![[seats/product.md]]

![[seats/architect.md]]

![[seats/engineer.md]]

![[seats/qa.md]]

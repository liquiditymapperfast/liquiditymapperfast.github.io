# Smoother motion without inventing data

Question: could a Kalman filter (or similar) add frames between data updates by estimating where each level of the book will move next?

## What the screen does today

The server sends a levels frame about 3.5 times a second. The ladder, profile, depth and the live column of the heatmap change when a frame arrives. The heatmap's time axis follows the clock (`#render` moves the view to `Date.now()`), but only when something asks for a repaint, so in practice it also advances about 3.5 times a second.

## Why not predict the book

A Kalman filter estimates a state that moves smoothly with noise: a price, a velocity. A level of the order book does not move; its size is changed by discrete events (an order added, cancelled or filled), and most of the interesting ones are decisions: a wall pulled before price reaches it, a bid stacked in front of a move. A forecast of that is one of two things: the last value held (nothing gained) or an average that shows liquidity that is not there. Either way the picture would stop being a record of what the books held, which is the whole point of the map, and the error would be largest at exactly the events people watch for. The mark price is the same: extrapolating it draws a line the market has not made.

## What does make it look smoother, honestly

1. **Advance the time axis every display frame.** Keep a `requestAnimationFrame` loop while the chart follows the live edge and the page is visible, shifting the view and redrawing the overlay at display rate (or 30 fps) instead of waiting for data. Nothing shown is invented; the whole chart simply stops stepping. Cost: a repaint per frame instead of per data frame, to be measured (the main thread is about 64 % idle today).
2. **Raise the real update rate where it matters.** Send the touch (the nearest levels) at 10 to 20 Hz as small deltas and the full book at 1 to 2 Hz. It also cuts bandwidth by an order of magnitude, which `docs/deployment.md` needs anyway.
3. **Ease between two real frames.** Move each ladder bar, profile bar and depth column from its previous value to its new one over at most one frame interval. The path is drawn, the end points are real, and the cost is under one frame of delay. Only worth doing after 1 and 2.
4. **Place trades at their own times.** Prints already carry timestamps; animating bubbles from their event time instead of their arrival time removes the stutter of batched arrivals.

Order of work: 1, then 2, then 3 if it still looks steppy. Record CPU before and after in `docs/deslop/` as the other performance work does.

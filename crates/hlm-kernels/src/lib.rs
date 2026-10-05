//! Compute kernels shared by the browser worker. Everything here is a pure function over flat
//! typed arrays so the JavaScript side owns all state and the wasm module holds none.

use wasm_bindgen::prelude::*;

/// Overlap length of `[a0, a1)` and `[b0, b1)`, never negative.
#[inline]
fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// Spread USD levels over a fixed price grid, one output row of `nbins` bins per instrument.
///
/// A level `[lo, hi)` contributes `usd * overlap / (hi - lo)` to each bin it touches; a point level
/// (`hi <= lo`) lands wholly in `floor(lo / step)`. Bins outside `[bin0, bin0 + nbins)` are dropped.
/// Output is instrument-major: `out[inst * nbins + (bin - bin0)]`.
#[wasm_bindgen]
pub fn spread_levels(lo: &[f64], hi: &[f64], usd: &[f64], inst: &[u32], n_inst: u32, step: f64, bin0: i32, nbins: u32) -> Vec<f32> {
    let n = lo.len().min(hi.len()).min(usd.len()).min(inst.len());
    let nb = nbins as usize;
    let mut acc = vec![0.0f64; n_inst as usize * nb];
    if !(step > 0.0) || nb == 0 {
        return vec![0.0; acc.len()];
    }
    for i in 0..n {
        let k = inst[i] as usize;
        if k >= n_inst as usize || !(usd[i] > 0.0) {
            continue;
        }
        let row = &mut acc[k * nb..(k + 1) * nb];
        let (l, h) = (lo[i], hi[i]);
        let first = (l / step).floor() as i64;
        if !(h > l) {
            let at = first - bin0 as i64;
            if at >= 0 && (at as usize) < nb {
                row[at as usize] += usd[i];
            }
            continue;
        }
        let last = ((h / step).ceil() as i64 - 1).max(first);
        let width = h - l;
        for bin in first.max(bin0 as i64)..=last.min(bin0 as i64 + nb as i64 - 1) {
            let o = overlap(l, h, bin as f64 * step, (bin + 1) as f64 * step);
            if o > 0.0 {
                row[(bin - bin0 as i64) as usize] += usd[i] * o / width;
            }
        }
    }
    acc.into_iter().map(|v| v as f32).collect()
}

/// Rasterise recorded minute columns into a `w x h` grid of interleaved `[bid, ask]` USD values.
///
/// Row 0 is the lowest price `p0`; column 0 is time `t0`. Per pixel column each instrument's value is the
/// mean over the time it was actually observed (gaps do not dim a neighbour). Per row the value is the USD
/// that falls inside the row's price band. `steps[i]` is instrument `i`'s grid step; `col_inst[c]` names a
/// column's instrument; `bins/bid/ask` hold every column's entries back to back (`col_count[c]` each).
///
/// A pixel column that lies wholly inside one recorded column takes that column's value with weight exactly 1, so
/// the sum over instruments is computed once per recorded time slot and written to all of the slot's interior
/// pixel columns; only the (at most two) pixel columns that straddle a slot boundary need per-instrument weights.
/// Zoomed out, a slot spans dozens of pixel columns, which is where the time used to go.
///
/// `sigma` (rows; 0 for none) smooths the result vertically as `blur_rows` would, but on the per-slot sums and the few boundary
/// columns instead of on every pixel column: identical pixel columns are blurred once.
#[wasm_bindgen]
pub fn raster_columns(
    steps: &[f64], col_inst: &[u32], col_time: &[f64], col_count: &[u32],
    bins: &[i32], bid: &[f32], ask: &[f32],
    step_ms: f64, t0: f64, t1: f64, p0: f64, p1: f64, w: u32, h: u32, sigma: f32,
) -> Vec<f32> {
    let (w, h) = (w as usize, h as usize);
    let mut out = vec![0.0f32; w * h * 2];
    if w == 0 || h == 0 || !(t1 > t0) || !(p1 > p0) || !(step_ms > 0.0) {
        return out;
    }
    let smooth = sigma >= 0.34;
    let n_inst = steps.len();
    let px_ms = (t1 - t0) / w as f64;
    let row_p = (p1 - p0) / h as f64;
    let inv_row = 1.0 / row_p;
    let ncols = col_inst.len().min(col_time.len()).min(col_count.len());

    // Pass 1: observed time covered per instrument per pixel column.
    let mut cover = vec![0.0f64; n_inst * w];
    let span = |t: f64| -> Option<(usize, usize)> {
        let (a, b) = (t.max(t0), (t + step_ms).min(t1));
        if b <= a { return None; }
        let x0 = (((a - t0) / px_ms).floor() as usize).min(w - 1);
        let x1 = ((((b - t0) / px_ms).ceil() as usize).max(x0 + 1) - 1).min(w - 1);
        Some((x0, x1))
    };
    for c in 0..ncols {
        let k = col_inst[c] as usize;
        if k >= n_inst || col_count[c] == 0 { continue; }
        let t = col_time[c];
        if let Some((x0, x1)) = span(t) {
            for x in x0..=x1 {
                let (px_a, px_b) = (t0 + x as f64 * px_ms, t0 + (x + 1) as f64 * px_ms);
                cover[k * w + x] += overlap(t, t + step_ms, px_a, px_b);
            }
        }
    }

    // Pass 2: per column build a price-row vector. Interior pixel columns share a per-slot sum; boundary ones are weighted.
    struct Slot { x0: usize, x1: usize, vb: Vec<f32>, va: Vec<f32> }
    let mut slots: std::collections::HashMap<u64, Slot> = std::collections::HashMap::new();
    let mut touched = vec![false; w];
    let mut vb = vec![0.0f32; h];
    let mut va = vec![0.0f32; h];
    let mut at = 0usize;
    for c in 0..ncols {
        let count = col_count[c] as usize;
        let k = col_inst[c] as usize;
        let (lo_i, hi_i) = (at, (at + count).min(bins.len()));
        at += count;
        if k >= n_inst || count == 0 { continue; }
        let Some((x0, x1)) = span(col_time[c]) else { continue };
        let step = steps[k];
        if !(step > 0.0) { continue; }
        vb.iter_mut().for_each(|v| *v = 0.0);
        va.iter_mut().for_each(|v| *v = 0.0);
        // Rows are addressed in fractional units (`rf0..rf1` is the bin's extent in rows), so a bin's share of row r is
        // `(min(rf1, r + 1) - max(rf0, r)) / (rf1 - rf0)` with one reciprocal per instrument instead of a division per bin and row.
        let bin_rows = step * inv_row;
        let inv_bin_rows = 1.0 / bin_rows;
        for e in lo_i..hi_i {
            let bl = bins[e] as f64 * step;
            let bh = bl + step;
            if bh <= p0 || bl >= p1 { continue; }
            let rf0 = (bl - p0) * inv_row;
            let rf1 = rf0 + bin_rows;
            let r0 = (rf0.max(0.0).floor() as usize).min(h - 1);
            let r1 = (((rf1.min(h as f64)).ceil() as usize).max(r0 + 1) - 1).min(h - 1);
            let (b, a) = (bid[e], ask[e]);
            if r0 == r1 {
                let share = ((rf1.min((r0 + 1) as f64) - rf0.max(r0 as f64)) * inv_bin_rows) as f32;
                if share > 0.0 { vb[r0] += b * share; va[r0] += a * share; }
                continue;
            }
            for r in r0..=r1 {
                let share = ((rf1.min((r + 1) as f64) - rf0.max(r as f64)) * inv_bin_rows) as f32;
                if share > 0.0 { vb[r] += b * share; va[r] += a * share; }
            }
        }
        let t = col_time[c];
        // Pixel columns lying wholly inside [t, t + step_ms).
        let first_full = ((t - t0) / px_ms - 1e-9).ceil().max(0.0) as usize;
        let last_full = ((t + step_ms - t0) / px_ms + 1e-9).floor() as i64 - 1;
        let (xi0, xi1) = (first_full.max(x0), if last_full < 0 { 0 } else { (last_full as usize).min(x1) });
        let has_interior = last_full >= 0 && xi0 <= xi1;
        for x in x0..=x1 {
            if has_interior && x >= xi0 && x <= xi1 { continue; }
            let (px_a, px_b) = (t0 + x as f64 * px_ms, t0 + (x + 1) as f64 * px_ms);
            let covered = cover[k * w + x];
            if covered <= 0.0 { continue; }
            let weight = (overlap(t, t + step_ms, px_a, px_b) / covered) as f32;
            touched[x] = true;
            for r in 0..h {
                let o = (r * w + x) * 2;
                out[o] += vb[r] * weight;
                out[o + 1] += va[r] * weight;
            }
        }
        if has_interior {
            let slot = slots.entry(t.to_bits()).or_insert_with(|| Slot { x0: xi0, x1: xi1, vb: vec![0.0; h], va: vec![0.0; h] });
            debug_assert!(slot.x0 == xi0 && slot.x1 == xi1);
            for r in 0..h { slot.vb[r] += vb[r]; slot.va[r] += va[r]; }
        }
    }
    if smooth {
        // Boundary columns carry per-instrument weights, so they are blurred as columns of the raster; the slot sums are blurred as vectors.
        let sigma = sigma as f64;
        let (mut cb, mut ca) = (vec![0.0f32; h], vec![0.0f32; h]);
        for x in (0..w).filter(|&x| touched[x]) {
            for r in 0..h { cb[r] = out[(r * w + x) * 2]; ca[r] = out[(r * w + x) * 2 + 1]; }
            blur_vec(&mut cb, sigma); blur_vec(&mut ca, sigma);
            for r in 0..h { out[(r * w + x) * 2] = cb[r]; out[(r * w + x) * 2 + 1] = ca[r]; }
        }
        for slot in slots.values_mut() { blur_vec(&mut slot.vb, sigma); blur_vec(&mut slot.va, sigma); }
    }
    for slot in slots.values() {
        for r in 0..h {
            let (b, a) = (slot.vb[r], slot.va[r]);
            if b == 0.0 && a == 0.0 { continue; }
            let base = r * w;
            for x in slot.x0..=slot.x1 {
                let o = (base + x) * 2;
                out[o] += b;
                out[o + 1] += a;
            }
        }
    }
    out
}

/// Box sizes (odd widths) whose three successive passes approximate a Gaussian of standard deviation `sigma` (Kutskir's method).
fn box_sizes(sigma: f64) -> [usize; 3] {
    let ideal = (12.0 * sigma * sigma / 3.0 + 1.0).sqrt();
    let mut lower = ideal.floor() as usize;
    if lower % 2 == 0 { lower -= 1; }
    let lower = lower.max(1);
    let upper = lower + 2;
    let l = lower as f64;
    let m = ((12.0 * sigma * sigma - 3.0 * l * l - 12.0 * l - 9.0) / (-4.0 * l - 4.0)).round().clamp(0.0, 3.0) as usize;
    [if 0 < m { lower } else { upper }, if 1 < m { lower } else { upper }, if 2 < m { lower } else { upper }]
}

/// One vertical box pass over rows of `stride` values: `dst[r] = mean of src[r-radius ..= r+radius]`, rows outside count as zero.
fn box_pass(src: &[f32], dst: &mut [f32], stride: usize, h: usize, radius: usize) {
    let mut sum = vec![0.0f64; stride];
    for r in 0..=radius.min(h.saturating_sub(1)) {
        let row = &src[r * stride..(r + 1) * stride];
        for (acc, v) in sum.iter_mut().zip(row) { *acc += *v as f64; }
    }
    let norm = 1.0 / (2 * radius + 1) as f64;
    for r in 0..h {
        let out = &mut dst[r * stride..(r + 1) * stride];
        for (o, acc) in out.iter_mut().zip(&sum) {
            let v = *acc * norm;
            *o = if v < 1e-3 { 0.0 } else { v as f32 };
        }
        let add = r + radius + 1;
        if add < h { let row = &src[add * stride..(add + 1) * stride]; for (acc, v) in sum.iter_mut().zip(row) { *acc += *v as f64; } }
        if r >= radius { let row = &src[(r - radius) * stride..(r - radius + 1) * stride]; for (acc, v) in sum.iter_mut().zip(row) { *acc -= *v as f64; } }
    }
}

/// One vertical box pass over a single vector: `dst[r]` is the mean of `src[r-radius ..= r+radius]`, rows outside count as zero.
fn box_pass_vec(src: &[f32], dst: &mut [f32], radius: usize) {
    let h = src.len();
    let mut sum = 0.0f64;
    for r in 0..=radius.min(h.saturating_sub(1)) { sum += src[r] as f64; }
    let norm = 1.0 / (2 * radius + 1) as f64;
    for r in 0..h {
        let v = sum * norm;
        dst[r] = if v < 1e-3 { 0.0 } else { v as f32 };
        let add = r + radius + 1;
        if add < h { sum += src[add] as f64; }
        if r >= radius { sum -= src[r - radius] as f64; }
    }
}

/// Gaussian-like smoothing of one vector (three box passes), the same arithmetic `blur_rows` applies to every column.
fn blur_vec(v: &mut Vec<f32>, sigma: f64) {
    let mut tmp = vec![0.0f32; v.len()];
    for size in box_sizes(sigma) { box_pass_vec(v, &mut tmp, (size - 1) / 2); std::mem::swap(v, &mut tmp); }
}

/// Smooth a raster (`w * h * 2` values, row-major, two channels) vertically with a Gaussian of `sigma` rows, as three box passes.
/// Mass is conserved away from the top and bottom edges. A `sigma` under a third of a row returns the input unchanged.
#[wasm_bindgen]
pub fn blur_rows(data: &[f32], w: u32, h: u32, sigma: f32) -> Vec<f32> {
    let (w, h) = (w as usize, h as usize);
    let stride = w * 2;
    if w == 0 || h == 0 || data.len() < stride * h || !(sigma >= 0.34) { return data.to_vec(); }
    let mut a = data[..stride * h].to_vec();
    let mut b = vec![0.0f32; stride * h];
    for size in box_sizes(sigma as f64) {
        box_pass(&a, &mut b, stride, h, (size - 1) / 2);
        std::mem::swap(&mut a, &mut b);
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The previous rasteriser, kept to check the optimised one against. Rasterise recorded minute columns into a `w x h` grid of interleaved `[bid, ask]` USD values.
    ///
    /// Row 0 is the lowest price `p0`; column 0 is time `t0`. Per pixel column each instrument's value is the
    /// mean over the time it was actually observed (gaps do not dim a neighbour). Per row the value is the USD
    /// that falls inside the row's price band. `steps[i]` is instrument `i`'s grid step; `col_inst[c]` names a
    /// column's instrument; `bins/bid/ask` hold every column's entries back to back (`col_count[c]` each).
    fn reference_raster_columns(
        steps: &[f64], col_inst: &[u32], col_time: &[f64], col_count: &[u32],
        bins: &[i32], bid: &[f32], ask: &[f32],
        step_ms: f64, t0: f64, t1: f64, p0: f64, p1: f64, w: u32, h: u32,
    ) -> Vec<f32> {
        let (w, h) = (w as usize, h as usize);
        let mut out = vec![0.0f32; w * h * 2];
        if w == 0 || h == 0 || !(t1 > t0) || !(p1 > p0) || !(step_ms > 0.0) {
            return out;
        }
        let n_inst = steps.len();
        let px_ms = (t1 - t0) / w as f64;
        let row_p = (p1 - p0) / h as f64;
        let ncols = col_inst.len().min(col_time.len()).min(col_count.len());

        // Pass 1: observed time covered per instrument per pixel column.
        let mut cover = vec![0.0f64; n_inst * w];
        let span = |t: f64| -> Option<(usize, usize)> {
            let (a, b) = (t.max(t0), (t + step_ms).min(t1));
            if b <= a { return None; }
            let x0 = (((a - t0) / px_ms).floor() as usize).min(w - 1);
            let x1 = ((((b - t0) / px_ms).ceil() as usize).max(x0 + 1) - 1).min(w - 1);
            Some((x0, x1))
        };
        for c in 0..ncols {
            let k = col_inst[c] as usize;
            if k >= n_inst || col_count[c] == 0 { continue; }
            let t = col_time[c];
            if let Some((x0, x1)) = span(t) {
                for x in x0..=x1 {
                    let (px_a, px_b) = (t0 + x as f64 * px_ms, t0 + (x + 1) as f64 * px_ms);
                    cover[k * w + x] += overlap(t, t + step_ms, px_a, px_b);
                }
            }
        }

        // Pass 2: per column build a price-row vector, then splat it across the pixel columns it covers.
        let mut vb = vec![0.0f32; h];
        let mut va = vec![0.0f32; h];
        let mut at = 0usize;
        for c in 0..ncols {
            let count = col_count[c] as usize;
            let k = col_inst[c] as usize;
            let (lo_i, hi_i) = (at, (at + count).min(bins.len()));
            at += count;
            if k >= n_inst || count == 0 { continue; }
            let Some((x0, x1)) = span(col_time[c]) else { continue };
            let step = steps[k];
            if !(step > 0.0) { continue; }
            vb.iter_mut().for_each(|v| *v = 0.0);
            va.iter_mut().for_each(|v| *v = 0.0);
            for e in lo_i..hi_i {
                let (bl, bh) = (bins[e] as f64 * step, (bins[e] as f64 + 1.0) * step);
                if bh <= p0 || bl >= p1 { continue; }
                let r0 = (((bl.max(p0) - p0) / row_p).floor() as usize).min(h - 1);
                let r1 = ((((bh.min(p1) - p0) / row_p).ceil() as usize).max(r0 + 1) - 1).min(h - 1);
                for r in r0..=r1 {
                    let share = overlap(bl, bh, p0 + r as f64 * row_p, p0 + (r + 1) as f64 * row_p) / step;
                    if share > 0.0 {
                        vb[r] += bid[e] * share as f32;
                        va[r] += ask[e] * share as f32;
                    }
                }
            }
            let t = col_time[c];
            for x in x0..=x1 {
                let (px_a, px_b) = (t0 + x as f64 * px_ms, t0 + (x + 1) as f64 * px_ms);
                let covered = cover[k * w + x];
                if covered <= 0.0 { continue; }
                let weight = (overlap(t, t + step_ms, px_a, px_b) / covered) as f32;
                for r in 0..h {
                    let o = (r * w + x) * 2;
                    out[o] += vb[r] * weight;
                    out[o + 1] += va[r] * weight;
                }
            }
        }
        out
    }



    fn pseudo(seed: &mut u64) -> f64 { *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((*seed >> 33) as f64) / ((1u64 << 31) as f64) }

    #[test]
    fn optimised_raster_matches_the_reference_on_random_data() {
        let mut seed = 42u64;
        for case in 0..40 {
            let n_inst = 1 + (pseudo(&mut seed) * 4.0) as usize;
            let steps: Vec<f64> = (0..n_inst).map(|_| [5.0, 10.0, 20.0][(pseudo(&mut seed) * 3.0) as usize]).collect();
            let step_ms = [60_000.0, 120_000.0][(pseudo(&mut seed) * 2.0) as usize];
            let n_slots = 3 + (pseudo(&mut seed) * 20.0) as usize;
            let (mut col_inst, mut col_time, mut col_count, mut bins, mut bid, mut ask) = (vec![], vec![], vec![], vec![], vec![], vec![]);
            for k in 0..n_inst {
                for slot in 0..n_slots {
                    if pseudo(&mut seed) < 0.15 { continue; } // gaps
                    let n = (pseudo(&mut seed) * 40.0) as usize;
                    col_inst.push(k as u32); col_time.push(slot as f64 * step_ms + (case % 3) as f64 * 7_000.0); col_count.push(n as u32);
                    let mut b = 1000 + (pseudo(&mut seed) * 50.0) as i32;
                    for _ in 0..n { bins.push(b); b += 1 + (pseudo(&mut seed) * 3.0) as i32; bid.push((pseudo(&mut seed) * 1000.0) as f32); ask.push((pseudo(&mut seed) * 500.0) as f32); }
                }
            }
            let width = 1 + (pseudo(&mut seed) * 120.0) as u32;
            let (t0, t1) = (step_ms * 0.4, step_ms * (n_slots as f64 - 0.3));
            let (p0, p1, hh) = (9_900.0, 9_900.0 + 20.0 + pseudo(&mut seed) * 800.0, 1 + (pseudo(&mut seed) * 90.0) as u32);
            let args = (&steps[..], &col_inst[..], &col_time[..], &col_count[..], &bins[..], &bid[..], &ask[..]);
            let fast = raster_columns(args.0, args.1, args.2, args.3, args.4, args.5, args.6, step_ms, t0, t1, p0, p1, width, hh, 0.0);
            let smoothed = raster_columns(args.0, args.1, args.2, args.3, args.4, args.5, args.6, step_ms, t0, t1, p0, p1, width, hh, 3.0);
            let blurred_after = blur_rows(&fast, width, hh, 3.0);
            assert_eq!(smoothed.len(), blurred_after.len());
            for (i, (a, b)) in smoothed.iter().zip(&blurred_after).enumerate() {
                assert!((a - b).abs() <= 2e-3 * b.abs().max(1.0), "case {case} cell {i}: blurred inside the kernel {a}, blurred afterwards {b}");
            }
            let slow = reference_raster_columns(args.0, args.1, args.2, args.3, args.4, args.5, args.6, step_ms, t0, t1, p0, p1, width, hh);
            assert_eq!(fast.len(), slow.len());
            for (i, (a, b)) in fast.iter().zip(&slow).enumerate() {
                assert!((a - b).abs() <= 1e-3 * b.abs().max(1.0), "case {case} cell {i}: optimised {a} reference {b}");
            }
        }
    }

    #[test]
    fn spread_point_band_and_partial_overlap() {
        let out = spread_levels(&[105.0, 100.0, 105.0], &[105.0, 130.0, 125.0], &[10.0, 30.0, 20.0], &[0, 0, 1], 2, 10.0, 10, 4);
        assert_eq!(out.len(), 8);
        // instrument 0: point in bin 10 (10) + band over bins 10..12 (10 each)
        assert_eq!(&out[0..4], &[20.0, 10.0, 10.0, 0.0]);
        // instrument 1: 20 USD over [105,125): 5, 10, 5
        assert_eq!(&out[4..8], &[5.0, 10.0, 5.0, 0.0]);
    }

    #[test]
    fn spread_drops_bins_outside_range() {
        let out = spread_levels(&[0.0, 1000.0], &[0.0, 1000.0], &[5.0, 5.0], &[0, 0], 1, 10.0, 10, 2);
        assert_eq!(out, vec![0.0, 0.0]);
    }

    #[test]
    fn raster_conserves_usd_in_price_and_averages_over_observed_time() {
        // One instrument, step 10: bin 10 = [100,110) holds 100 bid then 300 bid in the next minute.
        let steps = [10.0];
        let out = raster_columns(&steps, &[0, 0], &[0.0, 60_000.0], &[1, 1], &[10, 10], &[100.0, 300.0], &[0.0, 0.0],
            60_000.0, 0.0, 120_000.0, 100.0, 110.0, 2, 1, 0.0);
        assert_eq!(out, vec![100.0, 0.0, 300.0, 0.0]);
        // One pixel column spanning both minutes averages to 200.
        let wide = raster_columns(&steps, &[0, 0], &[0.0, 60_000.0], &[1, 1], &[10, 10], &[100.0, 300.0], &[0.0, 0.0],
            60_000.0, 0.0, 120_000.0, 100.0, 110.0, 1, 1, 0.0);
        assert_eq!(wide, vec![200.0, 0.0]);
    }

    #[test]
    fn raster_splits_a_bin_across_finer_rows_and_sums_into_coarser_rows() {
        let steps = [10.0];
        let fine = raster_columns(&steps, &[0], &[0.0], &[1], &[10], &[100.0], &[40.0], 60_000.0, 0.0, 60_000.0, 100.0, 110.0, 1, 2, 0.0);
        assert_eq!(fine, vec![50.0, 20.0, 50.0, 20.0]);
        let coarse = raster_columns(&steps, &[0], &[0.0], &[2], &[10, 11], &[100.0, 60.0], &[0.0, 0.0], 60_000.0, 0.0, 60_000.0, 100.0, 120.0, 1, 1, 0.0);
        assert_eq!(coarse, vec![160.0, 0.0]);
    }

    #[test]
    fn raster_gaps_do_not_dim_and_instruments_sum() {
        // Instrument 0 observed only the first minute; instrument 1 both. One wide pixel column.
        let steps = [10.0, 10.0];
        let out = raster_columns(&steps, &[0, 1, 1], &[0.0, 0.0, 60_000.0], &[1, 1, 1], &[10, 10, 10], &[100.0, 10.0, 30.0], &[0.0, 0.0, 0.0],
            60_000.0, 0.0, 120_000.0, 100.0, 110.0, 1, 1, 0.0);
        assert_eq!(out, vec![100.0 + 20.0, 0.0]);
    }

    #[test]
    fn raster_clips_to_viewport_and_ignores_degenerate_input() {
        let steps = [10.0];
        let out = raster_columns(&steps, &[0], &[-60_000.0], &[1], &[10], &[100.0], &[0.0], 60_000.0, 0.0, 60_000.0, 100.0, 110.0, 1, 1, 0.0);
        assert_eq!(out, vec![0.0, 0.0]);
        assert!(raster_columns(&steps, &[], &[], &[], &[], &[], &[], 60_000.0, 5.0, 5.0, 1.0, 2.0, 4, 4, 0.0).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn blur_spreads_a_spike_symmetrically_and_conserves_mass() {
        let (w, h) = (1usize, 81usize);
        let mut data = vec![0.0f32; w * h * 2];
        data[40 * 2] = 1000.0; data[40 * 2 + 1] = 500.0;
        let out = blur_rows(&data, w as u32, h as u32, 5.0);
        let bid: f32 = (0..h).map(|r| out[r * 2]).sum();
        let ask: f32 = (0..h).map(|r| out[r * 2 + 1]).sum();
        assert!((bid - 1000.0).abs() < 1.0 && (ask - 500.0).abs() < 1.0, "mass {bid} {ask}");
        assert!(out[40 * 2] < 1000.0 / 8.0 && out[40 * 2] > 1000.0 / 20.0, "peak {}", out[40 * 2]);
        for d in 1..20 { assert!((out[(40 - d) * 2] - out[(40 + d) * 2]).abs() < 1e-3 * out[40 * 2], "symmetry at {d}"); }
        assert!(out[40 * 2] > out[44 * 2] && out[44 * 2] > out[52 * 2]);
        assert!(out[0] == 0.0 && out[(h - 1) * 2] == 0.0, "the far rows stay empty");
    }

    #[test]
    fn blur_approximates_a_gaussian_width() {
        let h = 201usize;
        let mut data = vec![0.0f32; h * 2];
        data[100 * 2] = 1.0e6;
        let out = blur_rows(&data, 1, h as u32, 6.0);
        let mean: f64 = (0..h).map(|r| r as f64 * out[r * 2] as f64).sum::<f64>() / 1.0e6;
        let var: f64 = (0..h).map(|r| (r as f64 - mean).powi(2) * out[r * 2] as f64).sum::<f64>() / 1.0e6;
        assert!((var.sqrt() - 6.0).abs() < 0.6, "std {}", var.sqrt());
    }

    #[test]
    fn blur_leaves_small_sigma_and_bad_input_alone() {
        let data = vec![1.0f32, 2.0, 3.0, 4.0];
        assert_eq!(blur_rows(&data, 1, 2, 0.2), data);
        assert_eq!(blur_rows(&data, 0, 2, 5.0), data);
        assert_eq!(blur_rows(&data, 1, 3, 5.0), data, "a short buffer is returned as given");
        assert!(blur_rows(&[0.0; 8], 1, 4, 3.0).iter().all(|v| *v == 0.0), "empty stays exactly empty");
    }
}

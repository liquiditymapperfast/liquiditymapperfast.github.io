/* @ts-self-types="./hlm_kernels.d.ts" */

/**
 * Smooth a raster (`w * h * 2` values, row-major, two channels) vertically with a Gaussian of `sigma` rows, as three box passes.
 * Mass is conserved away from the top and bottom edges. A `sigma` under a third of a row returns the input unchanged.
 * @param {Float32Array} data
 * @param {number} w
 * @param {number} h
 * @param {number} sigma
 * @returns {Float32Array}
 */
export function blur_rows(data, w, h, sigma) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.blur_rows(retptr, ptr0, len0, w, h, sigma);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 4, 4);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Rasterise recorded minute columns into a `w x h` grid of interleaved `[bid, ask]` USD values.
 *
 * Row 0 is the lowest price `p0`; column 0 is time `t0`. Per pixel column each instrument's value is the
 * mean over the time it was actually observed (gaps do not dim a neighbour). Per row the value is the USD
 * that falls inside the row's price band. `steps[i]` is instrument `i`'s grid step; `col_inst[c]` names a
 * column's instrument; `bins/bid/ask` hold every column's entries back to back (`col_count[c]` each).
 *
 * A pixel column that lies wholly inside one recorded column takes that column's value with weight exactly 1, so
 * the sum over instruments is computed once per recorded time slot and written to all of the slot's interior
 * pixel columns; only the (at most two) pixel columns that straddle a slot boundary need per-instrument weights.
 * Zoomed out, a slot spans dozens of pixel columns, which is where the time used to go.
 *
 * `sigma` (rows; 0 for none) smooths the result vertically as `blur_rows` would, but on the per-slot sums and the few boundary
 * columns instead of on every pixel column: identical pixel columns are blurred once.
 * @param {Float64Array} steps
 * @param {Uint32Array} col_inst
 * @param {Float64Array} col_time
 * @param {Uint32Array} col_count
 * @param {Int32Array} bins
 * @param {Float32Array} bid
 * @param {Float32Array} ask
 * @param {number} step_ms
 * @param {number} t0
 * @param {number} t1
 * @param {number} p0
 * @param {number} p1
 * @param {number} w
 * @param {number} h
 * @param {number} sigma
 * @returns {Float32Array}
 */
export function raster_columns(steps, col_inst, col_time, col_count, bins, bid, ask, step_ms, t0, t1, p0, p1, w, h, sigma) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(steps, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(col_inst, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(col_time, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(col_count, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(bins, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF32ToWasm0(bid, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF32ToWasm0(ask, wasm.__wbindgen_export);
        const len6 = WASM_VECTOR_LEN;
        wasm.raster_columns(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, step_ms, t0, t1, p0, p1, w, h, sigma);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v8 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 4, 4);
        return v8;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Spread USD levels over a fixed price grid, one output row of `nbins` bins per instrument.
 *
 * A level `[lo, hi)` contributes `usd * overlap / (hi - lo)` to each bin it touches; a point level
 * (`hi <= lo`) lands wholly in `floor(lo / step)`. Bins outside `[bin0, bin0 + nbins)` are dropped.
 * Output is instrument-major: `out[inst * nbins + (bin - bin0)]`.
 * @param {Float64Array} lo
 * @param {Float64Array} hi
 * @param {Float64Array} usd
 * @param {Uint32Array} inst
 * @param {number} n_inst
 * @param {number} step
 * @param {number} bin0
 * @param {number} nbins
 * @returns {Float32Array}
 */
export function spread_levels(lo, hi, usd, inst, n_inst, step, bin0, nbins) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(lo, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(hi, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(usd, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(inst, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        wasm.spread_levels(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, n_inst, step, bin0, nbins);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v5 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 4, 4);
        return v5;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
    };
    return {
        __proto__: null,
        "./hlm_kernels_bg.js": import0,
    };
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('hlm_kernels_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

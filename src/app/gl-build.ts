/**
 * WebGL programs built beside the page (KHR_parallel_shader_compile). Asked how a program went right after linking it, the page waited on
 * this thread until the card had compiled and linked it, behind whatever else the card had to do first (the first frame's own drawing):
 * the glass's four programs held the page's first second for ~200 ms, before it had asked any market for anything, and the dust's three
 * another ~100 ms (Research_Findings.md, 2026-11-07). Started here, the card builds them on threads of its own; the first frame that finds
 * them built (`built`, which asks without waiting) reads their uniforms and draws. A card without the extension answers at once, as before.
 */

export interface Building { readonly program: WebGLProgram; readonly shaders: readonly WebGLShader[] }

type Parallel = { readonly COMPLETION_STATUS_KHR: number };
const parallel = new WeakMap<WebGL2RenderingContext, Parallel | null>();

/** The extension, asked for once a context, before its first program: asking is what lets the card build on threads of its own. */
function parallelOf(gl: WebGL2RenderingContext): Parallel | null {
  let ext = parallel.get(gl);
  if (ext === undefined) { ext = gl.getExtension('KHR_parallel_shader_compile') as Parallel | null; parallel.set(gl, ext); }
  return ext;
}

/** Compile and link a program from `vert` and `frag` without asking how it went (`built` asks). */
export function startProgram(gl: WebGL2RenderingContext, vert: string, frag: string): Building {
  parallelOf(gl);
  const shaders = ([[gl.VERTEX_SHADER, vert], [gl.FRAGMENT_SHADER, frag]] as const).map(([type, source]) => {
    const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); return shader;
  });
  const program = gl.createProgram()!;
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  return { program, shaders };
}

/**
 * Whether every one of `programs` is built: false while the card still builds one (and with the context lost), asked without waiting;
 * true once all of them linked. Throws what failed: the log of the shader that did not compile, else the program's.
 */
export function built(gl: WebGL2RenderingContext, programs: readonly Building[]): boolean {
  const ext = parallelOf(gl);
  if (ext && programs.some(b => gl.getProgramParameter(b.program, ext.COMPLETION_STATUS_KHR) !== true)) return false;
  for (const b of programs) {
    // A lost context answers null to everything: not built (yet), never failed.
    const linked: unknown = gl.getProgramParameter(b.program, gl.LINK_STATUS);
    if (linked === null) return false;
    if (linked) continue;
    const log = b.shaders.map(s => gl.getShaderParameter(s, gl.COMPILE_STATUS) ? '' : gl.getShaderInfoLog(s) ?? '').join('\n').trim();
    throw new Error(log || gl.getProgramInfoLog(b.program) || 'program');
  }
  return true;
}

/** The uniforms of a built program, by name. */
export function uniforms(gl: WebGL2RenderingContext, program: WebGLProgram, names: readonly string[]): Map<string, WebGLUniformLocation | null> {
  return new Map(names.map(name => [name, gl.getUniformLocation(program, name)]));
}

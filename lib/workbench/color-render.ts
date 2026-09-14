"use client";
import { parseCube, LUT_TEXT_LIMIT, type CubeLut } from "./color-lut";
import { defaultColorGrade, type ColorGrade } from "./color";
import type { Asset } from "./studio";

export async function loadCube(
  asset: Asset,
  signal: AbortSignal,
): Promise<CubeLut> {
  if (
    asset.kind !== "document" ||
    !asset.uploadId ||
    asset.url !== `/api/uploads/${asset.uploadId}`
  )
    throw new Error("Import the LUT into this workspace before applying it.");
  const response = await fetch(asset.url, {
    signal,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      "The LUT source is unavailable. Reconnect its original upload.",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    if (Number(response.headers.get("content-length")) > LUT_TEXT_LIMIT)
      throw new Error("Use a .cube file up to 16 MB.");
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > LUT_TEXT_LIMIT)
        throw new Error("Use a .cube file up to 16 MB.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return parseCube(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const vertex = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const fragment = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 result;
uniform sampler2D source;
uniform sampler3D cube;
uniform vec3 domainMin;
uniform vec3 domainMax;
uniform float cubeSize;
uniform float amount;
uniform vec3 correction;
uniform vec4 bounds;
vec3 lut(vec3 rgb) {
  vec3 p = clamp((rgb-domainMin)/(domainMax-domainMin),0.0,1.0)*(cubeSize-1.0);
  ivec3 lo = ivec3(floor(p)), hi = min(lo+1,ivec3(int(cubeSize)-1));
  vec3 f = fract(p);
  vec3 a = mix(texelFetch(cube,ivec3(lo.x,lo.y,lo.z),0).rgb,texelFetch(cube,ivec3(hi.x,lo.y,lo.z),0).rgb,f.x);
  vec3 b = mix(texelFetch(cube,ivec3(lo.x,hi.y,lo.z),0).rgb,texelFetch(cube,ivec3(hi.x,hi.y,lo.z),0).rgb,f.x);
  vec3 c = mix(texelFetch(cube,ivec3(lo.x,lo.y,hi.z),0).rgb,texelFetch(cube,ivec3(hi.x,lo.y,hi.z),0).rgb,f.x);
  vec3 d = mix(texelFetch(cube,ivec3(lo.x,hi.y,hi.z),0).rgb,texelFetch(cube,ivec3(hi.x,hi.y,hi.z),0).rgb,f.x);
  return mix(mix(a,b,f.y),mix(c,d,f.y),f.z);
}
void main() {
  vec4 original = texture(source,uv);
  vec2 top = vec2(uv.x,1.0-uv.y);
  if (top.x<bounds.x || top.y<bounds.y || top.x>bounds.z || top.y>bounds.w) { result=original; return; }
  vec3 rgb = (original.rgb*correction.x-0.5)*correction.y+0.5;
  rgb = mix(vec3(dot(rgb,vec3(0.2126,0.7152,0.0722))),rgb,correction.z);
  result = vec4(clamp(mix(rgb,lut(rgb),amount),0.0,1.0),original.a);
}`;

/** One shader is shared by the live preview and frame-accurate movie renderer.
 * NEAREST float textures + explicit trilinear sampling need no float-filter extension. */
export function createColorRenderer(lut?: CubeLut) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!gl)
    throw new Error(
      "Color processing requires WebGL 2. Enable graphics acceleration or bypass the sequence look.",
    );
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null,
    source: WebGLTexture | null = null,
    table: WebGLTexture | null = null;
  const dispose = () => {
    gl.deleteTexture(source);
    gl.deleteTexture(table);
    gl.deleteProgram(program);
    shaders.forEach((shader) => gl.deleteShader(shader));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  try {
    const compile = (type: number, code: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Color shader allocation failed.");
      shaders.push(shader);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("This device could not compile the color shader.");
      return shader;
    };
    program = gl.createProgram();
    if (!program) throw new Error("Color processor allocation failed.");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("This device could not initialize color processing.");
    gl.useProgram(program);
    source = gl.createTexture();
    table = gl.createTexture();
    if (!source || !table) throw new Error("Color texture allocation failed.");
    const uniform = (name: string) => gl.getUniformLocation(program!, name);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniform("source"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, table);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
      gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    const cube =
      lut ||
      parseCube(
        "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1",
      );
    const rgba = new Float32Array(cube.size ** 3 * 4);
    for (let i = 0; i < cube.values.length / 3; i++) {
      rgba.set(cube.values.subarray(i * 3, i * 3 + 3), i * 4);
      rgba[i * 4 + 3] = 1;
    }
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA32F,
      cube.size,
      cube.size,
      cube.size,
      0,
      gl.RGBA,
      gl.FLOAT,
      rgba,
    );
    gl.uniform1i(uniform("cube"), 1);
    gl.uniform1f(uniform("cubeSize"), cube.size);
    gl.uniform3fv(uniform("domainMin"), cube.min);
    gl.uniform3fv(uniform("domainMax"), cube.max);
    const amount = uniform("amount"),
      correction = uniform("correction"),
      bounds = uniform("bounds");
    return {
      canvas,
      dispose,
      render(
        input: HTMLCanvasElement,
        grade: ColorGrade = defaultColorGrade,
        rect?: { x: number; y: number; width: number; height: number },
      ) {
        if (gl.isContextLost())
          throw new Error(
            "Graphics processing was interrupted. Reload the page before rendering this look.",
          );
        if (canvas.width !== input.width || canvas.height !== input.height) {
          canvas.width = input.width;
          canvas.height = input.height;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          input,
        );
        gl.uniform1f(amount, grade.bypassed || !lut ? 0 : grade.mix);
        gl.uniform3f(
          correction,
          ...(grade.bypassed
            ? ([1, 1, 1] as const)
            : ([grade.brightness, grade.contrast, grade.saturation] as const)),
        );
        gl.uniform4f(
          bounds,
          rect ? rect.x / canvas.width : 0,
          rect ? rect.y / canvas.height : 0,
          rect ? (rect.x + rect.width) / canvas.width : 1,
          rect ? (rect.y + rect.height) / canvas.height : 1,
        );
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (gl.getError() !== gl.NO_ERROR)
          throw new Error("This device could not process the color frame.");
        return canvas;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

const vertexShaderSource = `#version 300 es
in vec2 aPosition;
in vec2 aUv;
uniform vec2 uScale;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition * uScale, 0.0, 1.0);
}`

const fragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uLightPosition;
uniform vec3 uKeyColor;
uniform vec3 uShadowColor;
uniform vec3 uRimColor;
uniform float uIntensity;
uniform float uSoftness;
uniform float uExposure;
uniform float uTemperature;
uniform float uShadows;
uniform float uContrast;
uniform float uSaturation;
uniform float uVignette;
uniform float uDepth;
uniform float uRim;
uniform float uOriginal;
in vec2 vUv;
out vec4 outputColor;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec4 source = texture(uSource, vUv);
  if (uOriginal > 0.5) {
    outputColor = source;
    return;
  }

  float left = luminance(texture(uSource, vUv - vec2(uTexel.x, 0.0)).rgb);
  float right = luminance(texture(uSource, vUv + vec2(uTexel.x, 0.0)).rgb);
  float top = luminance(texture(uSource, vUv - vec2(0.0, uTexel.y)).rgb);
  float bottom = luminance(texture(uSource, vUv + vec2(0.0, uTexel.y)).rgb);
  vec2 gradient = vec2(left - right, top - bottom);
  vec3 normal = normalize(vec3(gradient * (1.2 + uDepth * 3.6), 1.45));
  vec2 towardLight = (uLightPosition - vUv) * vec2(1.35, 1.0);
  vec3 lightDirection = normalize(vec3(towardLight * 1.7, 0.72));
  float diffuse = max(dot(normal, lightDirection), 0.0);
  float distanceToLight = length(towardLight);
  float falloff = exp(-distanceToLight * distanceToLight * mix(11.0, 2.0, uSoftness));
  float key = uIntensity * mix(0.18 + diffuse * 0.28, 0.28 + diffuse * 0.24, uSoftness) * (0.5 + falloff * 0.5);

  vec3 linear = pow(max(source.rgb, vec3(0.0)), vec3(2.2));
  float baseLuma = luminance(source.rgb);
  float shadowMask = 1.0 - smoothstep(0.08, 0.72, baseLuma);
  vec3 ambient = linear * (0.76 + uShadows * 0.3);
  vec3 lit = ambient + linear * uKeyColor * key;
  lit = mix(lit * uShadowColor, lit, 1.0 - shadowMask * (0.24 - uShadows * 0.14));

  float edge = clamp(length(gradient) * (1.8 + uDepth * 3.6), 0.0, 1.0);
  float rimSide = smoothstep(-0.2, 0.75, dot(normal.xy, -normalize(towardLight + vec2(0.0001))));
  lit += uRimColor * edge * rimSide * uRim * (0.04 + 0.14 * uIntensity);
  lit *= exp2(uExposure);

  vec3 warm = vec3(1.12, 0.92, 0.72);
  vec3 cool = vec3(0.72, 0.92, 1.13);
  vec3 temperatureTint = uTemperature >= 0.0
    ? mix(vec3(1.0), warm, uTemperature)
    : mix(vec3(1.0), cool, -uTemperature);
  lit *= temperatureTint;

  vec3 graded = pow(max(lit, vec3(0.0)), vec3(1.0 / 2.2));
  graded = (graded - 0.5) * uContrast + 0.5;
  float gray = luminance(graded);
  graded = mix(vec3(gray), graded, uSaturation);
  vec2 centered = vUv - 0.5;
  float vignette = smoothstep(0.9, 0.18, dot(centered, centered) * 1.55);
  graded *= mix(1.0, vignette, uVignette);
  outputColor = vec4(clamp(graded, 0.0, 1.0), source.a);
}`

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error("无法创建 WebGL 着色器")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "着色器编译失败"
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)
  const program = gl.createProgram()
  if (!program) throw new Error("无法创建 WebGL 程序")
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "着色器链接失败"
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function location(gl, program, name) {
  const value = gl.getUniformLocation(program, name)
  if (value === null) throw new Error("缺少 WebGL uniform: " + name)
  return value
}

export class RelightRenderer {
  constructor(canvas) {
    this.canvas = canvas
    this.gl = null
    this.program = null
    this.texture = null
    this.source = null
    this.sourceWidth = 1
    this.sourceHeight = 1
    this.sourceIsVideo = false
    this.ready = false
    this.contextState = "new"
  }

  initialize() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error("当前图形环境不支持 WebGL2")
    this.gl = gl
    this.program = createProgram(gl)
    const vertices = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0])
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT
    const position = gl.getAttribLocation(this.program, "aPosition")
    const uv = gl.getAttribLocation(this.program, "aUv")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)
    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.clearColor(0.035, 0.035, 0.045, 1)
    this.ready = true
    this.contextState = "ready"
  }

  setSource(source, dimensions, kind) {
    if (!this.gl || !this.texture) throw new Error("重打光渲染器尚未初始化")
    this.source = source
    this.sourceWidth = dimensions.width
    this.sourceHeight = dimensions.height
    this.sourceIsVideo = kind === "video"
    this.uploadSource()
  }

  uploadSource() {
    const gl = this.gl
    if (!gl || !this.texture || !this.source) return
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source)
  }

  clearSource() {
    this.source = null
    this.sourceIsVideo = false
    this.render(null)
  }

  resize() {
    const gl = this.gl
    if (!gl) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    gl.viewport(0, 0, width, height)
  }

  render(settings) {
    const gl = this.gl
    const program = this.program
    if (!gl || !program || this.contextState !== "ready") return
    this.resize()
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!this.source || !settings) return
    if (this.sourceIsVideo) this.uploadSource()
    gl.useProgram(program)
    const outputAspect = this.canvas.width / this.canvas.height
    const sourceAspect = this.sourceWidth / this.sourceHeight
    const scale = sourceAspect > outputAspect ? [1, outputAspect / sourceAspect] : [sourceAspect / outputAspect, 1]
    gl.uniform2f(location(gl, program, "uScale"), scale[0], scale[1])
    gl.uniform2f(location(gl, program, "uTexel"), 1 / this.sourceWidth, 1 / this.sourceHeight)
    gl.uniform2f(location(gl, program, "uLightPosition"), settings.lightX, settings.lightY)
    gl.uniform3fv(location(gl, program, "uKeyColor"), settings.keyColor)
    gl.uniform3fv(location(gl, program, "uShadowColor"), settings.shadowColor)
    gl.uniform3fv(location(gl, program, "uRimColor"), settings.rimColor)
    gl.uniform1f(location(gl, program, "uIntensity"), settings.intensity)
    gl.uniform1f(location(gl, program, "uSoftness"), settings.softness)
    gl.uniform1f(location(gl, program, "uExposure"), settings.exposure)
    gl.uniform1f(location(gl, program, "uTemperature"), settings.temperature)
    gl.uniform1f(location(gl, program, "uShadows"), settings.shadows)
    gl.uniform1f(location(gl, program, "uContrast"), settings.contrast)
    gl.uniform1f(location(gl, program, "uSaturation"), settings.saturation)
    gl.uniform1f(location(gl, program, "uVignette"), settings.vignette)
    gl.uniform1f(location(gl, program, "uDepth"), settings.depth)
    gl.uniform1f(location(gl, program, "uRim"), settings.rim)
    gl.uniform1f(location(gl, program, "uOriginal"), settings.showOriginal ? 1 : 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(location(gl, program, "uSource"), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}

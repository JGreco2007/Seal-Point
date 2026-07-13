// Minimal re-export of the ogl (github.com/oframe/ogl) modules the Aurora
// background actually uses — avoids vendoring the whole library (GLTFLoader,
// Text, GPGPU, Draco/Basis managers, etc. from the real 'ogl' package root).
export { Renderer } from './ogl/core/Renderer.js';
export { Program } from './ogl/core/Program.js';
export { Mesh } from './ogl/core/Mesh.js';
export { Color } from './ogl/math/Color.js';
export { Triangle } from './ogl/extras/Triangle.js';

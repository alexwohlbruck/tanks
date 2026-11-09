// Load every generated GLB with three.js' GLTFLoader (headless) and print the
// scene graph, so we know the files parse the way the game will see them.
//
//   bun tools/g3d/check_glb.ts [public/assets/models]
//
// Image decoding is stubbed (no DOM); geometry, materials, node names and
// extras are checked for real.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Minimal stubs so GLTFLoader's texture path does not throw in a non-DOM runtime.
const g = globalThis as any;
g.self ??= g;
g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
g.Blob ??= class {};
g.URL.createObjectURL ??= () => "blob:stub";
g.URL.revokeObjectURL ??= () => {};

const dir = process.argv[2] ?? "public/assets/models";
const loader = new GLTFLoader();
let failures = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".glb")).sort()) {
  const buf = readFileSync(join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const gltf: any = await new Promise((res, rej) => loader.parse(ab, "", res, rej));
    const lines: string[] = [];
    let tris = 0;
    gltf.scene.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const geo = m.geometry as THREE.BufferGeometry;
        tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
        const mat = m.material as THREE.MeshStandardMaterial;
        lines.push(
          `    mesh ${m.name} parent=${m.parent?.name} mat=${mat.name} ${mat.type}` +
            ` transparent=${mat.transparent} alphaTest=${mat.alphaTest} side=${mat.side}` +
            ` vcol=${mat.vertexColors} map=${mat.map ? "yes" : "no"} renderOrder(extras)=${m.userData.renderOrder}`,
        );
      } else if (o !== gltf.scene) {
        lines.push(`    node ${o.name} parent=${o.parent?.name}`);
      }
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    console.log(`${f}: tris=${tris} box=${box.min.toArray().map((v) => v.toFixed(2))}..${box.max.toArray().map((v) => v.toFixed(2))}`);
    console.log(lines.join("\n"));
  } catch (e) {
    failures++;
    console.log(`${f}: FAILED ${e}`);
  }
}
process.exit(failures ? 1 : 0);

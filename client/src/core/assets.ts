// glTF loading with self-hosted meshopt decoding and a small cache.
import { LoadAssetContainerAsync, MeshoptCompression, type AssetContainer, type Scene } from '@babylonjs/core';
import { registerBuiltInLoaders } from '@babylonjs/loaders/dynamic';

registerBuiltInLoaders();

MeshoptCompression.Configuration.decoder.url = `${import.meta.env.BASE_URL}vendor/meshopt_decoder.js`;

const cache = new Map<string, Promise<AssetContainer>>();

/** Load a GLB from /assets once per scene. */
export function loadContainer(scene: Scene, path: string): Promise<AssetContainer> {
  const key = `${scene.uid}:${path}`;
  let p = cache.get(key);
  if (!p) {
    p = LoadAssetContainerAsync(`${import.meta.env.BASE_URL}assets/${path}`, scene);
    cache.set(key, p);
  }
  return p;
}

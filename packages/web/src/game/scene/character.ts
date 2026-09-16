import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * The people on the street. Kenney's Blocky Characters ship the three clips this game
 * needs, so a player walks, sprints and stands still with the same body the server is
 * moving: 1.8 m tall, feet on the ground, facing along +z at yaw 0.
 */

export const SKINS = ["default", "neon", "carbon", "sand"] as const;

export type Skin = (typeof SKINS)[number];

export type Gait = "idle" | "walk" | "sprint";

const PLAYER_HEIGHT = 1.8;
const MODEL_PATH = "/models/characters";

/** Above this the legs run rather than walk, a little under the 7 m/s sprint gear. */
const SPRINT_FROM = 6.4;
const MOVING_FROM = 0.4;

/** The speed each clip was authored at, so the legs keep up with the ground. */
const CLIP_SPEED: Record<Gait, number> = { idle: 1, walk: 6, sprint: 7 };

const CROSSFADE_SECONDS = 0.18;

type Loaded = {
  model: THREE.Group;
  clips: Record<Gait, THREE.AnimationClip>;
};

const cache = new Map<string, Loaded>();

export function isSkin(value: string): value is Skin {
  return (SKINS as readonly string[]).includes(value);
}

function clipsOf(animations: THREE.AnimationClip[]): Record<Gait, THREE.AnimationClip> {
  const find = (name: Gait): THREE.AnimationClip => {
    const clip = animations.find((candidate) => candidate.name === name);
    if (!clip) throw new Error(`that character has no ${name} animation`);
    return clip;
  };
  return { idle: find("idle"), walk: find("walk"), sprint: find("sprint") };
}

/**
 * Lambert instead of the standard material the file ships with, for the same reason the
 * buildings use it: nothing here is metal and the cheaper shader is frames on a phone.
 */
function nightSkin(source: THREE.Material): THREE.MeshLambertMaterial {
  const map = (source as THREE.MeshStandardMaterial).map ?? null;
  if (map) {
    map.anisotropy = 1;
    map.magFilter = THREE.NearestFilter;
  }
  return new THREE.MeshLambertMaterial({ map, color: 0xd6dced });
}

/** Scales the model to 1.8 m and drops it so the soles sit on y 0. */
function stand(model: THREE.Group): THREE.Group {
  const bounds = new THREE.Box3().setFromObject(model);
  const height = bounds.max.y - bounds.min.y;
  const scale = height > 0 ? PLAYER_HEIGHT / height : 1;

  const holder = new THREE.Group();
  model.scale.setScalar(scale);
  model.position.y = -bounds.min.y * scale;
  holder.add(model);
  return holder;
}

/**
 * Pulls the character files down once. Every skin in the game is loaded here rather than
 * on sight, so nobody pops in as a grey block halfway through a fight.
 */
export async function loadCharacters(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  THREE.Cache.enabled = true;
  const loader = new GLTFLoader();
  let done = 0;

  await Promise.all(
    SKINS.map(async (skin) => {
      if (!cache.has(skin)) {
        const gltf = await loader.loadAsync(`${MODEL_PATH}/${skin}.glb`);
        const model = gltf.scene;
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (material) mesh.material = nightSkin(material);
        });
        cache.set(skin, { model, clips: clipsOf(gltf.animations) });
      }
      done += 1;
      onProgress?.(done, SKINS.length);
    }),
  );
}

export type Character = {
  group: THREE.Group;
  /** Crossfades to the gait that matches this ground speed in metres a second. */
  setMoving: (speed: number) => void;
  update: (deltaSeconds: number) => void;
  dispose: () => void;
};

function gaitFor(speed: number): Gait {
  if (speed < MOVING_FROM) return "idle";
  return speed >= SPRINT_FROM ? "sprint" : "walk";
}

/**
 * One body, ready to be put on the street. The model and its materials are shared with
 * every other character wearing the same skin; only the mixer belongs to this one.
 */
export function createCharacter(skin: string): Character {
  const loaded = cache.get(isSkin(skin) ? skin : "default") ?? cache.get("default");
  if (!loaded) throw new Error("the characters have not been loaded yet");

  const model = loaded.model.clone(true);
  const group = stand(model);
  const mixer = new THREE.AnimationMixer(model);

  const actions: Record<Gait, THREE.AnimationAction> = {
    idle: mixer.clipAction(loaded.clips.idle),
    walk: mixer.clipAction(loaded.clips.walk),
    sprint: mixer.clipAction(loaded.clips.sprint),
  };
  for (const action of Object.values(actions)) action.play().setEffectiveWeight(0);

  let gait: Gait = "idle";
  actions.idle.setEffectiveWeight(1);

  return {
    group,

    setMoving(speed: number) {
      const wanted = gaitFor(speed);
      const action = actions[wanted];
      action.timeScale =
        wanted === "idle" ? 1 : Math.min(1.6, Math.max(0.5, speed / CLIP_SPEED[wanted]));

      if (wanted === gait) return;

      // The incoming clip has to be enabled and at full weight before the fade starts, or
      // the two clips blend at weights that do not add up and the body comes apart.
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.play();
      action.crossFadeFrom(actions[gait], CROSSFADE_SECONDS, false);
      gait = wanted;
    },

    update(deltaSeconds: number) {
      mixer.update(deltaSeconds);
    },

    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
    },
  };
}

/** Frees the shared models. Call once, when the game screen goes away. */
export function disposeCharacters(): void {
  for (const loaded of cache.values()) {
    loaded.model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        (material as THREE.MeshLambertMaterial).map?.dispose();
        material.dispose();
      }
    });
  }
  cache.clear();
}

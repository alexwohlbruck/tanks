// Render quality presets (SceneView.setQuality). Nothing here is persisted; the settings
// menu owns storage and calls setQuality on start-up and on change.
//
//   classic  the GX-faithful look exactly as ported: disc textures, GX lighting, decal
//            shadows, MSAA, DPR capped at 2
//   high     hi-res textures (public/assets/hires, falls back per texture), mipmaps +
//            anisotropic filtering, smoothed curved models, hi-res tread stamps; same
//            GX lighting and decal shadows, so it costs about what classic costs (phone target)
//   ultra    high + enhanced lighting (lit by a key light + hemisphere fill, a soft specular
//            on the tanks) + real-time soft shadow maps + supersampled DPR (up to 3)

export type Quality = 'classic' | 'high' | 'ultra'

export interface RenderOptions {
  /** use public/assets/hires textures where present */
  hires: boolean
  /** PN-triangle smoothing of curved models (tank turrets, mine dome, border logs, shell) */
  smooth: boolean
  /** 'gx' = the original lighting equation; 'enhanced' = three.js lights */
  lighting: 'gx' | 'enhanced'
  /** real-time shadow maps (only with enhanced lighting) */
  shadows: boolean
  /** shadow map size (px) */
  shadowMapSize: number
  /** max device pixel ratio used for the canvas backing store */
  maxPixelRatio: number
  /** multiplier on devicePixelRatio before the cap (supersampling) */
  pixelRatioScale: number
  /** tread-mark capture resolution, pixels per world unit */
  treadPx: number
  /** anisotropic filtering for the hi-res textures */
  anisotropy: number
}

export const QUALITY_PRESETS: Record<Quality, RenderOptions> = {
  classic: { hires: false, smooth: false, lighting: 'gx', shadows: false, shadowMapSize: 0, maxPixelRatio: 2, pixelRatioScale: 1, treadPx: 2, anisotropy: 1 },
  high: { hires: true, smooth: true, lighting: 'gx', shadows: false, shadowMapSize: 0, maxPixelRatio: 2, pixelRatioScale: 1, treadPx: 2, anisotropy: 4 },
  ultra: { hires: true, smooth: true, lighting: 'enhanced', shadows: true, shadowMapSize: 2048, maxPixelRatio: 3, pixelRatioScale: 1.5, treadPx: 3, anisotropy: 8 },
}

export const QUALITIES: Quality[] = ['classic', 'high', 'ultra']

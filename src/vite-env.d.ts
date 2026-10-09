/// <reference types="vite/client" />
declare module 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url' { const url: string; export default url; }
interface ImportMetaEnv { readonly VITE_WORLD_TILES_URL?: string }

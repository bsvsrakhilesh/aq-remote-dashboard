/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_PUBLIC_READ_ONLY?: string
  readonly VITE_DEMO_MODE?: string
  readonly VITE_APP_NAME?: string
}

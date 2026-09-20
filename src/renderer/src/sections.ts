export type SectionId = 'process' | 'jobs' | 'logs' | 'library' | 'api' | 'settings'

export interface Section {
  id: SectionId
  label: string
  description: string
}

export const SECTIONS: Section[] = [
  { id: 'process', label: 'Procesar', description: 'Selecciona películas y encólalas para transcodificar.' },
  { id: 'jobs', label: 'Jobs', description: 'Progreso en tiempo real de los trabajos activos y en cola.' },
  { id: 'logs', label: 'Logs', description: 'Registro en tiempo real de todo lo que hace la aplicación, con el detalle de cada job.' },
  { id: 'library', label: 'Biblioteca', description: 'Explora los títulos generados en la carpeta de salida.' },
  { id: 'api', label: 'API', description: 'Cómo entregar películas desde otros programas a través de la API local.' },
  { id: 'settings', label: 'Configuración', description: 'Estándar de salida, calidades, duración de segmento y carpeta de salida.' }
]

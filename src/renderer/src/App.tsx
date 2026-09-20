import { useState } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { Api } from '@/sections/Api'
import { FirstRun } from '@/sections/FirstRun'
import { Jobs } from '@/sections/Jobs'
import { Library } from '@/sections/Library'
import { Logs, type LogsFilter } from '@/sections/Logs'
import { Process } from '@/sections/Process'
import { Settings } from '@/sections/Settings'
import { AppStateProvider, useAppState } from '@/state/AppState'
import { SECTIONS, type SectionId } from '@/sections'

export function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  )
}

function Shell() {
  const { ready, loadError, connection, config } = useAppState()
  const [active, setActive] = useState<SectionId>('process')
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null)
  const [logsFilter, setLogsFilter] = useState<LogsFilter>({})
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]!

  const navigate = (id: SectionId): void => {
    setActive(id)
    if (id !== 'library') setSelectedTitle(null)
    if (id === 'logs') setLogsFilter({})
  }

  // "Ver logs" from a job or a title opens the section already narrowed down
  const showLogs = (filter: LogsFilter): void => {
    setLogsFilter(filter)
    setActive('logs')
  }

  return (
    <div className="layout">
      <Sidebar active={active} onSelect={navigate} />
      <main className="panel">
        {!ready ? (
          <div className="panel__content">
            <p className="muted">{loadError ? `No se pudo conectar con la API: ${loadError}` : 'Conectando con la API…'}</p>
          </div>
        ) : config && config.outputFolder === null ? (
          <FirstRun />
        ) : (
          <>
            <header className="panel__header">
              <h1 className="panel__title">{section.label}</h1>
              <p className="panel__description">{section.description}</p>
            </header>
            {connection === 'offline' && <div className="alert alert--warn">Sin conexión con la API local. Reintentando…</div>}
            <section className="panel__content">
              {active === 'process' && <Process onNavigate={navigate} />}
              {active === 'jobs' && <Jobs onShowLogs={showLogs} />}
              {active === 'logs' && <Logs filter={logsFilter} onFilterChange={setLogsFilter} />}
              {active === 'library' && <Library selectedId={selectedTitle} onSelect={setSelectedTitle} onShowLogs={showLogs} />}
              {active === 'api' && <Api />}
              {active === 'settings' && <Settings />}
            </section>
          </>
        )}
      </main>
    </div>
  )
}

import { SECTIONS, type SectionId } from '@/sections'
import { useAppState } from '@/state/AppState'

interface SidebarProps {
  active: SectionId
  onSelect: (id: SectionId) => void
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  const { jobs, connection, apiVersion } = useAppState()
  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo" aria-hidden="true">LP</span>
        <span className="sidebar__title">LocalProcessor-Movies</span>
      </div>

      <nav className="sidebar__nav" aria-label="Secciones">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`sidebar__item${section.id === active ? ' sidebar__item--active' : ''}`}
            onClick={() => onSelect(section.id)}
          >
            <span>{section.label}</span>
            {section.id === 'jobs' && activeJobs > 0 && <span className="sidebar__count">{activeJobs}</span>}
          </button>
        ))}
      </nav>

      <footer className="sidebar__footer">
        <div className={`api-status api-status--${connection}`}>
          <span className="api-status__dot" aria-hidden="true" />
          <span className="api-status__text">
            <span>{connection === 'online' ? `API v${apiVersion ?? '?'}` : connection === 'offline' ? 'API sin conexión' : 'Conectando…'}</span>
          </span>
        </div>
      </footer>
    </aside>
  )
}

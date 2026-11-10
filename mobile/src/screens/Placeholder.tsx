import { EmptyState } from '../shell/States'

/** Screens that are built in later sprints of this branch. Removed before the branch is merged. */
export function Placeholder({ title }: { title: string }) {
  return (
    <section className="screen">
      <header className="screen-title"><h2>{title}</h2></header>
      <EmptyState title={`${title} is coming in a later update of this build`} />
    </section>
  )
}

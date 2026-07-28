import { notFound } from "next/navigation";
import { DocsShell } from "@/components/docs-shell";
import { docs, getDoc } from "@/lib/docs";

export function generateStaticParams() {
  return docs.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = getDoc(slug);
  return doc
    ? { title: doc.title, description: doc.description }
    : { title: "Not found" };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();

  const index = docs.findIndex((item) => item.slug === slug);
  const previous = index > 0 ? docs[index - 1] : undefined;
  const next = index < docs.length - 1 ? docs[index + 1] : undefined;

  return (
    <DocsShell
      activeSlug={slug}
      docs={docs.map(({ slug: itemSlug, title, section, description }) => ({
        slug: itemSlug,
        title,
        section,
        description,
      }))}
      headings={doc.headings}
      previous={previous && { slug: previous.slug, title: previous.title }}
      next={next && { slug: next.slug, title: next.title }}
    >
      <header className="doc-header">
        <p className="doc-kicker">
          <span>{doc.section}</span>
          <span className="doc-kicker-separator" aria-hidden="true">
            /
          </span>
          <span className="doc-kicker-current">{doc.title}</span>
        </p>
        <h1>{doc.title}</h1>
        <p className="doc-summary">{doc.description}</p>
      </header>
      <div className="doc-body">{doc.content}</div>
    </DocsShell>
  );
}

import { useEffect, useState } from "react";

export const Card = ({ title }: { title: string }) => {
  return <div>{title}</div>;
};

export function App() {
  const [n] = useState(0);
  useEffect(() => {
    document.title = String(n);
  }, [n]);
  return (
    <>
      <Card title="a" />
    </>
  );
}

export function useData() {
  return { rows: [] as number[] };
}

export function List({ rows }: { rows: number[] }) {
  const renderRow = (r: number) => <li key={r}>{r}</li>;
  return rows.map(renderRow);
}

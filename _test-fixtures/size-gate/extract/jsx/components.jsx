import { useEffect, useState } from "react";

export const Card = ({ title }) => {
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
  return { rows: [] };
}

export function List({ rows }) {
  const renderRow = (r) => <li key={r}>{r}</li>;
  return rows.map(renderRow);
}

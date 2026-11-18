import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type PillTone = 'ok' | 'warn' | 'bad' | 'info' | 'idle' | '';

export function Button({ variant = 'default', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' }) {
  return <button type="button" className={`btn btn-${variant} ${className}`.trim()} {...rest} />;
}

export function Pill({ tone = '', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`pill${tone ? ` pill-${tone}` : ''}`}>{children}</span>;
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

export function Card({ children, tone, className = '' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad'; className?: string }) {
  return <div className={`card${tone ? ` card-${tone}` : ''} ${className}`.trim()}>{children}</div>;
}

export function Stat({ value, label, tone, onClick }: { value: ReactNode; label: ReactNode; tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void }) {
  const body = (<><div className="stat-v">{value}</div><div className="muted">{label}</div></>);
  return onClick
    ? <button type="button" className={`card stat link${tone ? ` card-${tone}` : ''}`} onClick={onClick}>{body}</button>
    : <div className={`card stat${tone ? ` card-${tone}` : ''}`}>{body}</div>;
}

export const Cards = ({ children }: { children: ReactNode }) => <div className="cards">{children}</div>;
export const SectionTitle = ({ children, plain = false }: { children: ReactNode; plain?: boolean }) => <h3 className={`section${plain ? ' plain' : ''}`}>{children}</h3>;
export const Muted = ({ children, mono = false }: { children: ReactNode; mono?: boolean }) => <div className={`muted${mono ? ' mono' : ''}`}>{children}</div>;
export const EmptyState = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const ErrorText = ({ children }: { children: ReactNode }) => <div className="error" role="alert">{children}</div>;
export const Pre = ({ children, id, max }: { children: ReactNode; id?: string; max?: boolean }) => <pre id={id} className={`pre${max === false ? '' : ' pre-max'}`}>{children}</pre>;

export function Table({ head, children }: { head?: string[]; children: ReactNode }) {
  return (
    <table className="table">
      {head ? <thead><tr>{head.map((t, i) => <th key={i} scope="col">{t}</th>)}</tr></thead> : null}
      <tbody>{children}</tbody>
    </table>
  );
}

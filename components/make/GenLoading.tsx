import styles from "./gen.module.css";

export default function GenLoading() {
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <span className={styles.eyebrow}>Generation workspace</span>
      <p>Loading Gen…</p>
    </div>
  );
}

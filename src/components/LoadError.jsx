export default function LoadError({ title, detail, retryLabel, retryingLabel, retrying = false, onRetry }) {
  return (
    <div className="load-error" role="alert">
      <div className="load-error-title">{title}</div>
      {detail && <div className="load-error-detail">{detail}</div>}
      <button className="btn btn-primary" type="button" onClick={onRetry} disabled={retrying}>
        {retrying ? retryingLabel : retryLabel}
      </button>
    </div>
  );
}

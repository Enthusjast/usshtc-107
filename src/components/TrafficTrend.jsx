import { useId } from 'react';
import { useLocale } from '../i18n/LocaleContext';
import { formatBytes } from '../lib/format';
import { ZERO_RATES } from '../lib/traffic';

export default function TrafficTrend({ rates = ZERO_RATES, points = [] }) {
  const { t } = useLocale();
  const titleId = useId();
  const peak = Math.max(1, ...points.flatMap((point) => [point.sent, point.received]));
  const end = points.at(-1)?.second ?? 0;
  const path = (key) => points.map((point, index) => `${index ? 'L' : 'M'}${16 + (point.second - end + 59) / 59 * 568},${120 - point[key] / peak * 100}`).join(' ');
  return <section className="traffic-trend" aria-labelledby={titleId}>
    <h3 id={titleId}>{t('trafficTrend')}</h3>
    <dl className="traffic-rates">
      <div><dt><span className="traffic-line traffic-line-sent" aria-hidden="true" />{t('sentRate')}</dt><dd>{formatBytes(rates.sent)}/s</dd></div>
      <div><dt><span className="traffic-line traffic-line-received" aria-hidden="true" />{t('receivedRate')}</dt><dd>{formatBytes(rates.received)}/s</dd></div>
    </dl>
    {points.length === 0 ? <p className="text-muted">{t('trafficWaiting')}</p> : <>
      <svg viewBox="0 0 600 140" className="traffic-chart" role="img" aria-label={t('trafficChartDescription', formatBytes(peak) + '/s')}>
        <line x1="16" y1="120" x2="584" y2="120" stroke="var(--border-color)" />
        <path d={path('sent')} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        <path d={path('received')} fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeDasharray="7 5" />
      </svg>
      <div className="traffic-axis"><span>{t('trafficSixtySecondsAgo')}</span><span>{t('trafficNow')}</span></div>
      <details className="traffic-data"><summary>{t('trafficData')}</summary><div className="traffic-table-scroll" tabIndex={0} role="region" aria-label={t('trafficData')}>
        <table className="sessions-table"><caption className="sr-only">{t('trafficTrend')}</caption><thead><tr><th scope="col">{t('trafficSecondsAgo')}</th><th scope="col">{t('sentRate')}</th><th scope="col">{t('receivedRate')}</th></tr></thead><tbody>
          {points.map((point) => <tr key={point.second}><th scope="row">{end - point.second}</th><td>{formatBytes(point.sent)}/s</td><td>{formatBytes(point.received)}/s</td></tr>)}
        </tbody></table>
      </div></details>
    </>}
  </section>;
}

import React, { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider, useToast } from '../src/components/Toast';

function ToastTrigger() {
  const pushToast = useToast();
  const countRef = useRef(0);
  return (
    <button type="button" onClick={() => {
      countRef.current += 1;
      pushToast('info', `notice ${countRef.current}`);
    }}>
      Notify
    </button>
  );
}

function renderToasts() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Toast queue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps only the five most recent notifications', () => {
    renderToasts();

    const trigger = screen.getByRole('button', { name: 'Notify' });
    for (let index = 0; index < 6; index += 1) fireEvent.click(trigger);

    expect(screen.queryByText('notice 1')).not.toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(5);
    expect(screen.getByText('notice 6')).toBeInTheDocument();
  });
});

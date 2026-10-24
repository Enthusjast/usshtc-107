import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../src/contexts/ThemeContext';

const electronMocks = vi.hoisted(() => ({
  getTheme: vi.fn(),
  setTheme: vi.fn(),
  onThemeChanged: vi.fn(),
}));

vi.mock('../src/lib/electron', () => electronMocks);

function ThemeProbe() {
  const { theme, toggleTheme } = useTheme();
  return <button type="button" onClick={() => { void toggleTheme().catch(() => {}); }}>{theme}</button>;
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  );
}

describe('Theme context persistence', () => {
  let emitThemeChange;

  beforeEach(() => {
    emitThemeChange = undefined;
    document.documentElement.removeAttribute('data-theme');
    electronMocks.getTheme.mockReset().mockResolvedValue('dark');
    electronMocks.setTheme.mockReset().mockResolvedValue({});
    electronMocks.onThemeChanged.mockReset().mockImplementation((callback) => {
      emitThemeChange = callback;
      return vi.fn();
    });
  });

  it('keeps the default dark theme when the stored theme cannot be loaded', async () => {
    electronMocks.getTheme.mockRejectedValueOnce(new Error('settings unavailable'));

    renderTheme();

    expect(screen.getByRole('button', { name: 'dark' })).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));
  });

  it('keeps React and DOM on the previous theme when persistence rejects', async () => {
    electronMocks.setTheme.mockRejectedValueOnce(new Error('write failed'));
    renderTheme();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));

    await waitFor(() => expect(electronMocks.setTheme).toHaveBeenCalledWith('light'));
    expect(screen.getByRole('button', { name: 'dark' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('updates React and DOM after persistence succeeds', async () => {
    renderTheme();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));

    expect(await screen.findByRole('button', { name: 'light' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('does not let a stale initial read overwrite a newer theme event', async () => {
    let resolveTheme;
    electronMocks.getTheme.mockReturnValue(new Promise((resolve) => {
      resolveTheme = resolve;
    }));
    renderTheme();

    emitThemeChange('light');
    resolveTheme('dark');

    expect(await screen.findByRole('button', { name: 'light' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('does not apply a stale initial theme read after a preference save has already started', async () => {
    let finishRead;
    let finishWrite;
    electronMocks.getTheme.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    electronMocks.setTheme.mockImplementation(() => new Promise((resolve) => { finishWrite = resolve; }));
    renderTheme();
    fireEvent.click(screen.getByRole('button', {name:'dark'}));
    finishRead('light');
    await waitFor(() => expect(electronMocks.setTheme).toHaveBeenCalledWith('light'));
    expect(screen.getByRole('button', {name:'dark'})).toBeInTheDocument();
    finishWrite({});
    expect(await screen.findByRole('button', {name:'light'})).toBeInTheDocument();
  });
});

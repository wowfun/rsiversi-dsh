import {join} from 'node:path';

// RSI's five homes resolve independently, including the package and credential store.
export function homeOptions(home) {
  return ['--config-home',join(home,'config/rsi'),'--data-home',join(home,'data/rsi'),
    '--state-home',join(home,'state/rsi'),'--cache-home',join(home,'cache/rsi'),'--tmp-home',join(home,'tmp')];
}

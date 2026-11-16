import { processRecurringExpenses } from './services/finance.js';
import { syncNotifications } from './services/notify.js';

export function startJobs() {
  const run = async () => {
    try {
      await processRecurringExpenses();
      await syncNotifications();
    } catch (error) {
      console.error('Scheduled job failed:', error.message);
    }
  };
  setTimeout(run, 4000);
  setInterval(run, 15 * 60 * 1000);
}

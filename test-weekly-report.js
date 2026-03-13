'use strict';

process.env.USE_SUPABASE = 'false';  // Use SQLite for testing

const { runWeeklyReport } = require('./report');

async function test() {
  try {
    console.log('Starting weekly report test (dry run)...');
    const report = await runWeeklyReport(true);
    
    if (report) {
      console.log('✅ Report generated successfully!');
      console.log('Length:', report.length);
      console.log('Preview:');
      console.log(report.substring(0, 500) + '...');
    } else {
      console.log('❌ Report is null - no qualifying news this week');
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error('Stack:', err.stack);
  }
}

test();
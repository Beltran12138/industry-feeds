const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkTable() {
  console.log('Verifying user_preferences table in Supabase...');
  
  const { data, error } = await supabase
    .from('user_preferences')
    .select('*')
    .limit(1);

  if (error) {
    if (error.code === '42P01') {
      console.error('❌ Table "user_preferences" does not exist yet. Please make sure you executed the SQL script in your Supabase SQL Editor.');
    } else {
      console.error('❌ Error accessing user_preferences table:', error.message, error);
    }
  } else {
    console.log('✅ Table "user_preferences" exists and is accessible!');
    console.log('Current row count (limit 1):', data.length);
  }
}

checkTable();

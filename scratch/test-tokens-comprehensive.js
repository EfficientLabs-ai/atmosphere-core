import fetch from 'node-fetch';

const tokens = {
  cfut: 'cfut_C8iYuwZ8OtUSmovxneQuFfAOrfaSqsQVNhY0yM9r7f495f1c',
  cfat: 'cfat_O5VMa9E4XHjnW2MUlb3IDixilBwyC0NUsM0ipqWrfc7cdd6d'
};
const zoneId = '900f9d6f8095a3ee936dc91046320f03';

async function runTest() {
  for (const [name, token] of Object.entries(tokens)) {
    console.log(`\n================= Testing Token: ${name} (${token.substring(0, 12)}...) =================`);
    
    // 1. Verify token
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      console.log(`🔑 /user/tokens/verify: success=${data.success}`, data.errors || '');
    } catch (e) {
      console.log(`🔑 /user/tokens/verify error:`, e.message);
    }

    // 2. Query zones list
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/zones?name=efficientlabs.ai', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      console.log(`🌐 /zones?name=efficientlabs.ai: success=${data.success}`, data.success ? `found=${data.result.length}` : data.errors);
    } catch (e) {
      console.log(`🌐 /zones error:`, e.message);
    }

    // 3. Query specific zone
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      console.log(`🎯 /zones/${zoneId}: success=${data.success}`, data.success ? `status=${data.result.status}` : data.errors);
    } catch (e) {
      console.log(`🎯 /zones/${zoneId} error:`, e.message);
    }

    // 4. Query dns_records
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      console.log(`📡 /zones/${zoneId}/dns_records: success=${data.success}`, data.success ? `records=${data.result.length}` : data.errors);
    } catch (e) {
      console.log(`📡 /zones/${zoneId}/dns_records error:`, e.message);
    }
  }
}

runTest();

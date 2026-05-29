const rawTokens = [
  'C8iYuwZ8OtUSmovxneQuFfAOrfaSqsQVNhY0yM9r7f495f1c',
  'O5VMa9E4XHjnW2MUlb3IDixilBwyC0NUsM0ipqWrfc7cdd6d'
];

const zoneId = '900f9d6f8095a3ee936dc91046320f03';

async function testRealTokens() {
  for (const token of rawTokens) {
    try {
      console.log(`📡 Querying Cloudflare zones using raw token: ${token.substring(0, 10)}...`);
      const res = await fetch('https://api.cloudflare.com/client/v4/zones?name=efficientlabs.ai', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await res.json();
      console.log('🤖 Cloudflare Response:', JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('❌ Error:', err);
    }
  }
}

testRealTokens();

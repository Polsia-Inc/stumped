/**
 * Verify the quiz engine works end-to-end
 * Run: node verify-quiz-engine.js
 */
const BASE = process.env.APP_URL || 'https://stumped.polsia.app';

async function verify() {
  console.log('Testing quiz engine at:', BASE);

  // 1. Health check
  console.log('\n1. Health check...');
  const health = await fetch(`${BASE}/health`);
  const healthData = await health.json();
  console.log('   Status:', healthData.status);
  if (healthData.status !== 'healthy') throw new Error('Health check failed');

  // 2. Landing page
  console.log('\n2. Landing page...');
  const landing = await fetch(BASE);
  const landingHtml = await landing.text();
  const hasForm = landingHtml.includes('topic-input') && landingHtml.includes('generate-btn');
  console.log('   Has quiz form:', hasForm);
  if (!hasForm) throw new Error('Landing page missing quiz generation form');

  // 3. Generate a quiz
  console.log('\n3. Generating quiz...');
  const genRes = await fetch(`${BASE}/api/quizzes/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'World Capitals' })
  });
  const genData = await genRes.json();
  console.log('   Slug:', genData.slug);
  console.log('   Topic:', genData.topic);
  console.log('   Questions:', genData.questionCount);
  console.log('   URL:', genData.url);
  if (!genData.slug || genData.questionCount !== 10) throw new Error('Quiz generation failed');

  // 4. Fetch quiz data
  console.log('\n4. Fetching quiz data...');
  const quizRes = await fetch(`${BASE}/api/quizzes/${genData.slug}`);
  const quizData = await quizRes.json();
  console.log('   Topic:', quizData.topic);
  console.log('   Questions:', quizData.questions.length);
  console.log('   Sample Q:', quizData.questions[0].question);
  if (quizData.questions.length !== 10) throw new Error('Quiz data incomplete');

  // 5. Quiz page (check OG tags)
  console.log('\n5. Quiz page with OG tags...');
  const pageRes = await fetch(`${BASE}/quiz/${genData.slug}`);
  const pageHtml = await pageRes.text();
  const hasOG = pageHtml.includes('og:title') && pageHtml.includes('og:description');
  const hasTwitter = pageHtml.includes('twitter:card');
  console.log('   Has OG tags:', hasOG);
  console.log('   Has Twitter card:', hasTwitter);
  if (!hasOG) throw new Error('Missing OG tags');

  // 6. Submit answers
  console.log('\n6. Submitting answers...');
  const answers = {};
  quizData.questions.forEach(q => {
    answers[q.number] = 'A'; // Just pick A for all
  });
  const submitRes = await fetch(`${BASE}/api/quizzes/${genData.slug}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName: 'TestBot', answers, timeTaken: 45 })
  });
  const submitData = await submitRes.json();
  console.log('   Score:', submitData.score + '/' + submitData.total);
  console.log('   Percentage:', submitData.percentage + '%');
  if (submitData.total !== 10) throw new Error('Submit failed');

  // 7. Leaderboard
  console.log('\n7. Leaderboard...');
  const lbRes = await fetch(`${BASE}/api/quizzes/${genData.slug}/leaderboard`);
  const lbData = await lbRes.json();
  console.log('   Entries:', lbData.entries.length);
  console.log('   #1:', lbData.entries[0]?.playerName, lbData.entries[0]?.score + '/' + lbData.entries[0]?.total);
  if (lbData.entries.length === 0) throw new Error('Leaderboard empty');

  console.log('\n✅ All tests passed! Quiz engine is fully operational.');
  console.log('   Quiz URL:', `${BASE}/quiz/${genData.slug}`);
}

verify().catch(err => {
  console.error('\n❌ Verification failed:', err.message);
  process.exit(1);
});

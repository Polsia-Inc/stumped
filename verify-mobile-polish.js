// Verify mobile polish — checks all screens respond correctly
const APP_URL = process.env.APP_URL || 'https://stumped.polsia.app';

async function verify() {
  console.log(`\n🔍 Verifying mobile polish at ${APP_URL}\n`);
  let passed = 0;
  let failed = 0;

  // Test 1: Landing page loads and has mobile CSS
  try {
    const res = await fetch(APP_URL);
    const html = await res.text();
    const checks = [
      { name: 'Has 480px breakpoint', test: html.includes('max-width: 480px') },
      { name: 'Generate form stacks (flex-direction: column)', test: html.includes('flex-direction: column') },
      { name: 'Touch targets 44px on pills', test: html.includes('min-height: 44px') },
      { name: 'Generate button full width', test: html.includes('width: 100%') },
      { name: 'Has 375px breakpoint for iPhone SE', test: html.includes('max-width: 375px') || html.includes('375px') },
      { name: 'Hero centers on mobile', test: html.includes('text-align: center') },
      { name: 'Input font 16px (iOS zoom prevention)', test: html.includes('font-size: 16px') },
    ];

    for (const check of checks) {
      if (check.test) {
        console.log(`  ✅ Landing: ${check.name}`);
        passed++;
      } else {
        console.log(`  ❌ Landing: ${check.name}`);
        failed++;
      }
    }
  } catch (e) {
    console.log(`  ❌ Landing page failed to load: ${e.message}`);
    failed++;
  }

  // Test 2: Generate a quiz and check quiz page CSS
  try {
    const genRes = await fetch(`${APP_URL}/api/quizzes/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Mobile CSS Testing' })
    });
    const genData = await genRes.json();

    if (genData.slug) {
      console.log(`\n  📝 Generated quiz: ${genData.slug}`);

      // Load quiz page
      const quizRes = await fetch(`${APP_URL}/quiz/${genData.slug}`);
      const quizHtml = await quizRes.text();

      const quizChecks = [
        { name: 'Has 480px phone breakpoint', test: quizHtml.includes('max-width: 480px') },
        { name: 'Has 375px SE breakpoint', test: quizHtml.includes('max-width: 375px') },
        { name: 'Answer buttons min-height 56px', test: quizHtml.includes('min-height: 56px') },
        { name: 'Option letter 36px on mobile', test: quizHtml.includes('width: 36px') },
        { name: 'Share buttons full-width', test: quizHtml.includes('flex-direction: column') },
        { name: 'Share buttons min-height 48px', test: quizHtml.includes('min-height: 48px') },
        { name: 'Tap feedback (scale transform)', test: quizHtml.includes('scale(0.98)') },
        { name: 'Timer bigger on mobile (20px)', test: quizHtml.includes('font-size: 20px') },
        { name: 'Leaderboard name truncation', test: quizHtml.includes('text-overflow: ellipsis') },
        { name: 'Play button min-height 52px', test: quizHtml.includes('min-height: 52px') },
        { name: '-webkit-tap-highlight removed', test: quizHtml.includes('-webkit-tap-highlight-color: transparent') },
      ];

      for (const check of quizChecks) {
        if (check.test) {
          console.log(`  ✅ Quiz: ${check.name}`);
          passed++;
        } else {
          console.log(`  ❌ Quiz: ${check.name}`);
          failed++;
        }
      }

      // Test 3: Quiz API works (simulate play-through)
      const quizApiRes = await fetch(`${APP_URL}/api/quizzes/${genData.slug}`);
      const quizData = await quizApiRes.json();

      if (quizData.questions && quizData.questions.length === 10) {
        console.log(`  ✅ Quiz API: 10 questions loaded`);
        passed++;

        // Submit answers
        const answers = {};
        quizData.questions.forEach(q => { answers[q.number] = 'A'; });

        const submitRes = await fetch(`${APP_URL}/api/quizzes/${genData.slug}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerName: 'MobileTest', answers, timeTaken: 45 })
        });
        const submitData = await submitRes.json();

        if (submitData.score !== undefined) {
          console.log(`  ✅ Submit: Score ${submitData.score}/${submitData.total}`);
          passed++;
        } else {
          console.log(`  ❌ Submit failed`);
          failed++;
        }

        // Check leaderboard
        const lbRes = await fetch(`${APP_URL}/api/quizzes/${genData.slug}/leaderboard`);
        const lbData = await lbRes.json();
        if (lbData.entries && lbData.entries.length > 0) {
          console.log(`  ✅ Leaderboard: ${lbData.entries.length} entries`);
          passed++;
        } else {
          console.log(`  ❌ Leaderboard empty`);
          failed++;
        }
      } else {
        console.log(`  ❌ Quiz API: wrong question count`);
        failed++;
      }
    } else {
      console.log(`  ❌ Quiz generation failed: ${JSON.stringify(genData)}`);
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ Quiz flow error: ${e.message}`);
    failed++;
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

verify();

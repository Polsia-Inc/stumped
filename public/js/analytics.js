// Stumped Analytics - Client-side event tracking
// Fire-and-forget tracking - never blocks UI

(function() {
  'use strict';

  // Generate or retrieve visitor ID from localStorage
  function getVisitorId() {
    let visitorId = localStorage.getItem('stumped_visitor_id');
    if (!visitorId) {
      visitorId = 'v_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
      localStorage.setItem('stumped_visitor_id', visitorId);
    }
    return visitorId;
  }

  // Track event (fire-and-forget)
  function track(eventType, metadata = {}) {
    const visitorId = getVisitorId();
    const eventData = {
      visitor_id: visitorId,
      event_type: eventType,
      page_path: window.location.pathname,
      referrer: document.referrer || null,
      metadata: metadata
    };

    // Send asynchronously with keepalive (works even if user navigates away)
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData),
      keepalive: true
    }).catch(() => {
      // Silently fail - never interrupt user experience
    });
  }

  // Expose global analytics object
  window.StumpedAnalytics = {
    track: track,

    // Convenience methods for common events
    trackQuizGenerateStart: (topic) => track('quiz_generate_start', { topic }),
    trackQuizGenerateComplete: (slug, topic) => track('quiz_generate_complete', { slug, topic }),
    trackQuizPlayStart: (slug) => track('quiz_play_start', { slug }),
    trackQuizPlayComplete: (slug, score, totalQuestions) => track('quiz_play_complete', {
      slug,
      score,
      total_questions: totalQuestions,
      score_percentage: Math.round((score / totalQuestions) * 100)
    }),
    trackExploreView: () => track('explore_view'),
    trackExploreQuizClick: (slug) => track('explore_quiz_click', { slug }),
    trackSignupStart: () => track('signup_start'),
    trackSignupComplete: (email) => track('signup_complete', { email }),
    trackLoginComplete: (email) => track('login_complete', { email })
  };

  // Auto-track page view on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => track('page_view'));
  } else {
    track('page_view');
  }
})();

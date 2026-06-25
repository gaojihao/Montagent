/**
 * Minimal schema-valid artifact fixtures, ported verbatim from
 * /Users/fanhui/Montagent/tests/contracts/test_phase0_contracts.py
 * (the `sample_artifact` helper). Each returns the smallest object that passes
 * the corresponding schema in schemas/artifacts/.
 */

export function sampleArtifact(name: string): Record<string, any> {
  switch (name) {
    case "research_brief":
      return {
        version: "1.0",
        topic: "Test Topic",
        research_date: "2026-03-27",
        landscape: {
          existing_content: [
            { title: "Existing Video 1", source: "youtube", angle: "tutorial", what_it_covers: "basics" },
            { title: "Existing Video 2", source: "blog", angle: "deep dive", what_it_covers: "advanced" },
            { title: "Existing Video 3", source: "youtube", angle: "comparison", what_it_covers: "alternatives" },
          ],
          saturated_angles: ["basic tutorial"],
          underserved_gaps: ["misconceptions about topic"],
        },
        data_points: [
          { claim: "73% of users prefer X", source_url: "https://example.com/study", credibility: "primary_source" },
          { claim: "Market grew 40% in 2025", source_url: "https://example.com/report", credibility: "secondary_source" },
          { claim: "Most experts agree on Y", source_url: "https://example.com/survey", credibility: "primary_source" },
        ],
        audience_insights: {
          common_questions: ["What is X?", "How does X work?", "Why is X important?"],
          misconceptions: [{ myth: "X is slow", reality: "X is fast" }],
          knowledge_level: "Beginner to intermediate",
        },
        angles_discovered: [
          { name: "The Surprising Truth", hook: "You think X is slow. It's not.", type: "contrarian", why_now: "New benchmark data", grounded_in: ["data_point_1"] },
          { name: "X From Scratch", hook: "Build X in 5 minutes.", type: "evergreen", why_now: "Audience demand", grounded_in: ["audience_q1"] },
          { name: "Why X Matters Now", hook: "X just changed everything.", type: "trending", why_now: "Recent announcement", grounded_in: ["trending_1"] },
        ],
        sources: [
          { url: "https://example.com/study", title: "Study on X", used_for: "data_points" },
          { url: "https://example.com/report", title: "Market Report", used_for: "data_points" },
          { url: "https://example.com/survey", title: "Expert Survey", used_for: "data_points" },
          { url: "https://example.com/reddit", title: "Reddit Discussion", used_for: "audience_insights" },
          { url: "https://example.com/blog", title: "Tech Blog", used_for: "landscape" },
        ],
      };
    case "proposal_packet":
      return {
        version: "1.0",
        concept_options: [
          { id: "c1", title: "The Surprising Truth About X", hook: "You think X is slow.", narrative_structure: "myth_busting", visual_approach: "animated diagrams", target_duration_seconds: 60, why_this_works: "Strong misconception found in research" },
          { id: "c2", title: "X From Scratch", hook: "Build X in 5 minutes.", narrative_structure: "tutorial", visual_approach: "code walkthrough", target_duration_seconds: 90, why_this_works: "High demand in audience questions" },
          { id: "c3", title: "Why X Matters Now", hook: "X just changed everything.", narrative_structure: "timeline", visual_approach: "motion graphics", target_duration_seconds: 75, why_this_works: "Recent announcement creates timeliness" },
        ],
        selected_concept: { concept_id: "c1", rationale: "Strongest research backing" },
        production_plan: {
          pipeline: "animated-explainer",
          render_runtime: "remotion",
          stages: [
            { stage: "script", tools: [], approach: "Write from research" },
            { stage: "assets", tools: [{ tool_name: "tts_selector", role: "narration", available: true }], approach: "Generate assets" },
          ],
        },
        cost_estimate: {
          total_estimated_usd: 0.52,
          line_items: [{ tool: "elevenlabs_tts", operation: "narration", estimated_usd: 0.18 }],
          budget_verdict: "within_budget",
        },
        approval: { status: "approved" },
      };
    case "brief":
      return {
        version: "1.0",
        title: "Test Brief",
        hook: "Did you know?",
        key_points: ["point 1"],
        tone: "casual",
        style: "clean-professional",
        target_platform: "youtube",
        target_duration_seconds: 60,
      };
    case "script":
      return {
        version: "1.0",
        title: "Test Script",
        total_duration_seconds: 60,
        sections: [{ id: "s1", text: "Hello world", start_seconds: 0, end_seconds: 10 }],
      };
    case "scene_plan":
      return {
        version: "1.0",
        scenes: [
          { id: "scene-1", type: "talking_head", description: "Host on camera", start_seconds: 0, end_seconds: 10 },
        ],
      };
    case "asset_manifest":
      return {
        version: "1.0",
        assets: [
          { id: "asset-1", type: "video", path: "assets/clip.mp4", source_tool: "ffmpeg", scene_id: "scene-1" },
        ],
      };
    case "edit_decisions":
      return {
        version: "1.0",
        cuts: [{ id: "cut-1", source: "asset-1", in_seconds: 0, out_seconds: 10 }],
      };
    case "render_report":
      return {
        version: "1.0",
        outputs: [{ path: "renders/output.mp4", format: "mp4", resolution: "1920x1080", duration_seconds: 60 }],
      };
    case "publish_log":
      return {
        version: "1.0",
        entries: [{ platform: "youtube", status: "draft", timestamp: new Date().toISOString() }],
      };
    case "video_analysis_brief":
      return {
        version: "1.0",
        source: { type: "youtube", url: "https://example.com/watch?v=abc123def45", title: "Reference Video", duration_seconds: 60 },
        content_analysis: { summary: "A fast explainer reference.", topics: ["quantum computing"], target_audience: "general" },
        structure_analysis: {
          total_scenes: 3,
          scenes: [
            { scene_index: 0, start_time: 0, end_time: 5, description: "Hook" },
            { scene_index: 1, start_time: 5, end_time: 20, description: "Setup" },
            { scene_index: 2, start_time: 20, end_time: 60, description: "Payoff" },
          ],
          pacing_profile: { avg_scene_duration_seconds: 20, cuts_per_minute: 3, pacing_style: "steady_educational" },
        },
      };
    default:
      throw new Error(`Unknown artifact sample: ${name}`);
  }
}

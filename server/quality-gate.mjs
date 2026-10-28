/**
 * Deterministic quality signals for standalone web deliverables.
 * Scores are evidence-based diagnostics; absent/invalid measurements fail closed.
 */
export const PRODUCTION_QUALITY_THRESHOLD = 90;

function clamp(value){
 if(!Number.isFinite(value))return 0;
 return Math.max(0,Math.min(100,value));
}

export function calculateQualityGate(signals,threshold=PRODUCTION_QUALITY_THRESHOLD){
 const syntax=clamp(signals.syntax),tests=clamp(signals.tests),security=clamp(signals.security),performance=clamp(signals.performance);
 const score=Math.round((.30*syntax+.30*tests+.20*security+.20*performance)*10)/10;
 return {syntax,tests,security,performance,score,threshold,passed:score>=threshold};
}

export function scoreStandaloneHtmlSecurity(html){
 if(typeof html!=='string')return 0;
 let score=100;
 const hazards=[
  [/<script[^>]+src\s*=\s*["']https?:\/\//i,30],
  [/\beval\s*\(/i,35],
  [/new\s+Function\s*\(/i,35],
  [/document\.write\s*\(/i,20],
  [/javascript\s*:/i,25],
  [/http:\/\//i,15]
 ];
 for(const [pattern,penalty]of hazards)if(pattern.test(html))score-=penalty;
 return clamp(score);
}

export function scoreStandaloneHtmlPerformance(bytes){
 if(!Number.isFinite(bytes)||bytes<=0)return 0;
 if(bytes<=100_000)return 100;
 if(bytes<=250_000)return 90;
 if(bytes<=500_000)return 75;
 if(bytes<=1_000_000)return 55;
 return 30;
}

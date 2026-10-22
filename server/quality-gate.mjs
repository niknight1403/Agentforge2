export const QUALITY_THRESHOLD = 85;
const clamp=(value)=>Number.isFinite(Number(value))?Math.max(0,Math.min(100,Number(value))):0;
export function calculateQualityGate({syntax=0,tests=0,security=0,performance=0}={},threshold=QUALITY_THRESHOLD){
 const signals={syntax:clamp(syntax),tests:clamp(tests),security:clamp(security),performance:clamp(performance)};
 const score=Math.round((0.30*signals.syntax+0.30*signals.tests+0.20*signals.security+0.20*signals.performance)*10)/10;
 return {...signals,score,threshold,passed:score>=threshold};
}
export function staticPerformanceScore(bytes){
 const n=Number(bytes)||0;
 if(n<=0)return 0;
 if(n<=1_000_000)return 100;
 if(n<=5_000_000)return 95;
 if(n<=10_000_000)return 85;
 if(n<=20_000_000)return 70;
 return 50;
}
export function staticSecurityScore(findings=[]){
 const n=Array.isArray(findings)?findings.length:99;
 return n===0?100:0;
}

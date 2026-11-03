import{readFileSync}from"node:fs";const x=readFileSync("dist/index.html","utf8");if(!x.includes("NexusSphere"))throw Error("smoke failed");console.log("smoke ok");

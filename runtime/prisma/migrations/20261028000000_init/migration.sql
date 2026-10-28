-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED');

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" UUID NOT NULL,
    "requestKey" VARCHAR(180),
    "hubTaskId" INTEGER,
    "hubVillaId" INTEGER,
    "title" VARCHAR(500) NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStep" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "agentId" VARCHAR(160) NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "toolName" VARCHAR(160) NOT NULL,
    "arguments" JSONB NOT NULL,
    "result" JSONB,
    "error" VARCHAR(4000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCheckpoint" (
    "id" CHAR(64) NOT NULL,
    "taskId" UUID NOT NULL,
    "agentId" VARCHAR(160) NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "parentId" CHAR(64),
    "sourceId" VARCHAR(180),
    "stateSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEventReceipt" (
    "id" VARCHAR(180) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "taskId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTelemetry" (
    "id" VARCHAR(180) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "taskId" UUID,
    "agentId" VARCHAR(160),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "AgentTelemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentOutbox" (
    "id" VARCHAR(180) NOT NULL,
    "stream" VARCHAR(180) NOT NULL,
    "event" JSONB NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentTask_requestKey_key" ON "AgentTask"("requestKey");

-- CreateIndex
CREATE INDEX "AgentTask_status_createdAt_idx" ON "AgentTask"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTask_hubTaskId_hubVillaId_createdAt_idx" ON "AgentTask"("hubTaskId", "hubVillaId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentStep_taskId_stepNumber_idx" ON "AgentStep"("taskId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_taskId_agentId_stepNumber_key" ON "AgentStep"("taskId", "agentId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCheckpoint_sourceId_key" ON "AgentCheckpoint"("sourceId");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_taskId_agentId_stepNumber_idx" ON "AgentCheckpoint"("taskId", "agentId", "stepNumber" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCheckpoint_taskId_agentId_stepNumber_key" ON "AgentCheckpoint"("taskId", "agentId", "stepNumber");

-- CreateIndex
CREATE INDEX "AgentEventReceipt_taskId_createdAt_idx" ON "AgentEventReceipt"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTelemetry_taskId_occurredAt_idx" ON "AgentTelemetry"("taskId", "occurredAt");

-- CreateIndex
CREATE INDEX "AgentTelemetry_eventType_occurredAt_idx" ON "AgentTelemetry"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "AgentOutbox_publishedAt_createdAt_idx" ON "AgentOutbox"("publishedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCheckpoint" ADD CONSTRAINT "AgentCheckpoint_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;


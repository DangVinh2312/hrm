import { Module } from '@nestjs/common';
import { TeamController } from './team.controller.js';

/** Needs TEAM_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [TeamController] })
export class TeamModule {}

import { Module } from '@nestjs/common';
import { SettingController } from './setting.controller.js';

/** Needs SETTING_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [SettingController] })
export class SettingModule {}

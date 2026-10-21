import { Controller, Get } from '@nestjs/common';
import { ProductPublic } from '../authorization/enforcement/product-authorization.module.js';
import { productOpenApi } from './schemas/product-openapi.schema.js';

@Controller('api')
export class OpenApiController {
  @Get('openapi.json')
  @ProductPublic()
  openapi() {
    return productOpenApi;
  }
}

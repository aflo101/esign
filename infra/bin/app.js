#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { EsignStack } from '../lib/esign-stack.js';

const app = new App();
new EsignStack(app, 'EsignStack', {
  env: { account: '157861504221', region: 'us-east-1' },
  domainName: 'esign.rippleconsultingservices.com',
  zoneName: 'rippleconsultingservices.com',
  hostedZoneId: 'Z09922683660ADI0CXUK8',
  sesFrom: 'esign@rippleconsultingservices.com',
  sesReplyTo: 'esign@rippleconsultingservices.com',
  senderName: 'Alex Flores',
  legacySenderEmail: 'aflores@miltonindustries.com',
  configurationSet: 'esign-events',
  description: 'esign — self-hosted e-signature service',
});

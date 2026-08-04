import {
  Stack, Duration, RemovalPolicy, CfnOutput,
  aws_dynamodb as ddb,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_lambda as lambda,
  aws_cloudfront as cf,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_iam as iam,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, '..', '..', 'backend');
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');

export class EsignStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { domainName, hostedZoneId, zoneName, sesFrom, sesReplyTo, senderName, configurationSet } = props;

    // --- Data ----------------------------------------------------------------
    // RETAIN + PITR + deletion protection: this table IS the audit trail for executed
    // contracts. An accidental `cdk destroy` must not be able to erase it.
    const table = new ddb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'SK', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Versioned so a signed PDF can never be silently replaced or lost.
    const docs = new s3.Bucket(this, 'Docs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [{
        allowedOrigins: [`https://${domainName}`, 'http://localhost:5173'],
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3000,
      }],
      lifecycleRules: [
        // An abandoned presigned upload leaves an object with no document record.
        { id: 'abort-incomplete', abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { id: 'expire-old-versions', noncurrentVersionExpiration: Duration.days(365) },
      ],
    });

    const site = new s3.Bucket(this, 'Site', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Secrets (Parameter Store, not Secrets Manager: $0 vs $0.40/secret/mo) ---
    const jwtSecret = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'JwtSecret', {
      parameterName: '/esign/jwt-secret',
    });
    const senderPassword = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SenderPassword', {
      parameterName: '/esign/sender-password',
    });
    const originSecret = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'OriginSecret', {
      parameterName: '/esign/origin-secret',
    });

    // --- Compute -------------------------------------------------------------
    const fn = new lambda.Function(this, 'Api', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/handler.handler',
      code: lambda.Code.fromAsset(BACKEND, {
        exclude: ['.env', '.env.example', 'node_modules/.cache', '*.log'],
      }),
      memorySize: 1024,          // pdf-lib/pdfkit flatten is CPU-bound; memory buys CPU
      timeout: Duration.seconds(30),
      environment: {
        NODE_ENV: 'production',
        DDB_TABLE: table.tableName,
        S3_BUCKET: docs.bucketName,
        APP_BASE_URL: `https://${domainName}`,
        EMAIL_MODE: 'ses',
        SES_FROM: sesFrom,
        SES_FROM_NAME: 'esign',
        SES_REPLY_TO: sesReplyTo,
        SES_CONFIGURATION_SET: configurationSet,
        SENDER_NAME: senderName,
        JWT_SECRET_PARAM: jwtSecret.parameterName,
        SENDER_PASSWORD_PARAM: senderPassword.parameterName,
        ORIGIN_SECRET_PARAM: originSecret.parameterName,
      },
      // Caps blast radius if the public signer routes are ever hammered.
      reservedConcurrentExecutions: 20,
    });

    table.grantReadWriteData(fn);
    docs.grantReadWrite(fn);
    jwtSecret.grantRead(fn);
    senderPassword.grantRead(fn);
    originSecret.grantRead(fn);
    // SendRawEmail as well as SendEmail: this service sends raw MIME (to attach the signed
    // PDF + evidence package), and SESv2 authorizes that under ses:SendRawEmail.
    // Scoped to the one identity and one configuration set rather than "*".
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/${zoneName}`,
        `arn:aws:ses:${this.region}:${this.account}:configuration-set/${configurationSet}`,
      ],
    }));

    // AuthType NONE — CloudFront authenticates with a shared secret header instead.
    // See the ORIGIN_SECRET note in server.js for why OAC is unusable here.
    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // --- Edge ----------------------------------------------------------------
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName });

    const cert = new acm.Certificate(this, 'Cert', {
      domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Strips the /api prefix so the Express routes are identical in dev (Vite proxy) and prod.
    const stripApi = new cf.Function(this, 'StripApi', {
      runtime: cf.FunctionRuntime.JS_2_0,
      code: cf.FunctionCode.fromInline(`
function handler(event) {
  var r = event.request;
  r.uri = r.uri.replace(/^\\/api/, '') || '/';
  return r;
}`),
    });

    // SPA routing for the default (site) behavior only.
    //
    // Distribution-level errorResponses (403/404 -> /index.html) CANNOT be used here: they
    // apply to every behavior, so a genuine 400/404 from /api/* came back as the SPA shell
    // with status 200 — masking real API errors and breaking every client that parses JSON.
    // Rewriting extensionless paths at the edge keeps the fallback scoped to the site.
    const spaRewrite = new cf.Function(this, 'SpaRewrite', {
      runtime: cf.FunctionRuntime.JS_2_0,
      code: cf.FunctionCode.fromInline(`
function handler(event) {
  var uri = event.request.uri;
  // Anything without a file extension is a client-side route (/s/<token>, /prepare/<id>).
  if (uri.indexOf('.') === -1) event.request.uri = '/index.html';
  return event.request;
}`),
    });

    const apiOrigin = new origins.FunctionUrlOrigin(fnUrl, {
      customHeaders: { 'x-esign-origin': process.env.ESIGN_ORIGIN_SECRET || 'SET_AT_DEPLOY' },
    });

    const distribution = new cf.Distribution(this, 'Cdn', {
      domainNames: [domainName],
      certificate: cert,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{
          function: spaRewrite,
          eventType: cf.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cf.AllowedMethods.ALLOW_ALL,
          cachePolicy: cf.CachePolicy.CACHING_DISABLED,
          // Forwards Authorization (sender Bearer) and the viewer address used by the
          // audit trail. ALL_VIEWER_EXCEPT_HOST_HEADER is required for a Function URL
          // origin — a forwarded Host would break SigV4/host matching.
          originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [{
            function: stripApi,
            eventType: cf.FunctionEventType.VIEWER_REQUEST,
          }],
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'SiteDeploy', {
      sources: [s3deploy.Source.asset(FRONTEND_DIST)],
      destinationBucket: site,
      distribution,
      distributionPaths: ['/*'],
    });

    new route53.ARecord(this, 'Alias', {
      zone,
      recordName: domainName.replace(`.${zoneName}`, ''),
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new CfnOutput(this, 'Url', { value: `https://${domainName}` });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'DocsBucket', { value: docs.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}

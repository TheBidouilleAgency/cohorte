// Static tier routing and authentication policy (PLAN U3.10).
import { type ErrorInfo, err, errorOf, ok, type Result } from '@cohorte/base';
import type { AuthPolicy, ModelRequest, ResolvedModel, RoutingInput } from '../contract.ts';

export function resolveModel(request: ModelRequest, config: RoutingInput): Result<ResolvedModel, ErrorInfo> {
  const tier = request.tier ?? config.routing.defaults[request.role as keyof typeof config.routing.defaults];
  if (tier === undefined)
    return err(errorOf('provider-terminal/model-not-found', `no model tier is configured for role ${request.role}`));
  const target = config.routing.tiers[tier];
  if (target === undefined || !config.routing.allowedProviders.includes(target.ref.provider))
    return err(
      errorOf('provider-terminal/model-not-found', `tier ${tier} is not available for the configured providers`),
    );
  const auth = createAuthPolicy(config).decide(target.ref.provider);
  if (!auth.ok) return auth;
  return ok({
    ref: target.ref,
    thinking: target.thinking,
    tier,
    baseUrl:
      target.ref.provider === 'openai-codex'
        ? 'https://chatgpt.com/backend-api'
        : `https://${target.ref.provider}.invalid`,
    access: auth.value.access,
  });
}

/** DESIGN 1.1 names `AuthPolicy` in the barrel: that is the TYPE (contract.ts); this is its factory. */
export function createAuthPolicy(config: RoutingInput): AuthPolicy {
  const policy: AuthPolicy = {
    mode: config.authentication.mode,
    allowApiKeys: config.authentication.allowApiKeys,
    allowedProviders: Object.freeze([...config.routing.allowedProviders]),
    decide(provider) {
      if (!config.routing.allowedProviders.includes(provider))
        return err(errorOf('provider-terminal/entitlement', `provider ${provider} is not in the allowlist`));
      if (provider === 'anthropic') {
        const optIn = config.authentication.anthropicSubscriptionViaPi;
        if (!optIn?.enabled || !optIn.acknowledgePerTokenBilling || !optIn.acknowledgeProviderTermsRisk)
          return err(
            errorOf(
              'security/auth-mode-violation',
              'Anthropic through Pi requires all billing and terms acknowledgements',
            ),
          );
        return ok({ provider, access: 'pi-oauth', authMode: 'api', metered: true });
      }
      if (config.authentication.mode === 'subscription')
        return ok({ provider, access: 'pi-oauth', authMode: 'subscription', metered: false });
      if (!config.authentication.allowApiKeys)
        return err(errorOf('security/auth-mode-violation', 'API-key authentication is disabled by configuration'));
      return ok({ provider, access: 'api-key', authMode: 'api', metered: true });
    },
  };
  return Object.freeze(policy);
}

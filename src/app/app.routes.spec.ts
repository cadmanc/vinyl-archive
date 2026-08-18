import { routes } from './app.routes';

describe('application routes', () => {
  it('redirects the root URL to the collection', () => {
    expect(routes.find((route) => route.path === '')).toMatchObject({
      redirectTo: 'collection',
      pathMatch: 'full',
    });
  });

  it('keeps the recommendation player available at /player', () => {
    const playerRoute = routes.find((route) => route.path === 'player');

    expect(playerRoute?.canActivate).toBeTruthy();
    expect(playerRoute?.loadComponent).toBeTruthy();
  });

  it('keeps the Collection route available', () => {
    expect(routes.find((route) => route.path === 'collection')).toBeTruthy();
  });
});

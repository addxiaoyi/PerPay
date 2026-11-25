import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { PortalWiki } from '../src/portal/wiki-page';
it('searches and deep-links the SDK topic with a public downloadable archive',()=>{
 render(<MemoryRouter initialEntries={['/docs?topic=sdk']}><PortalWiki/></MemoryRouter>);
 expect(screen.getByRole('link',{name:/下载余额支付适配 SDK/})).toHaveAttribute('href',expect.stringContaining('/epay/docs/balance-merchant-sdk.zip'));
 fireEvent.change(screen.getByRole('textbox',{name:'搜索功能文档'}),{target:{value:'找不到的功能xyz'}});
 expect(screen.getByText(/没有匹配章节/)).toBeVisible();
 fireEvent.change(screen.getByRole('textbox',{name:'搜索功能文档'}),{target:{value:'充值'}});
 expect(screen.getByRole('navigation',{name:'Wiki章节'})).toHaveTextContent('充值');
});

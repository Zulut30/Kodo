"""Offline adapter boundaries; never launch browsers or call providers."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ui_bridge', Path(__file__).parents[2] / 'runtime/ui-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='kodo-ui-python-')
        self.addCleanup(self.tmp.cleanup)
        self.req = dict(schemaVersion=1, maxSteps=4, timeoutMs=2000, evidenceDir=self.tmp.name,
                        cdpUrl='http://127.0.0.1:34567', cdpUrls=['http://127.0.0.1:34567'],
                        executablePath='/owned/chrome', case=dict(id='case', tool='browser-use', url='http://127.0.0.1:1234/', goal='Save', steps=[], assertions=[dict(selector='#result', text='Saved', exists=True)]))

    def test_bridge_rejects_foreign_cdp_and_malformed_budget(self):
        for delta in [dict(cdpUrl='https://user-browser.example'), dict(cdpUrl='http://user:pw@127.0.0.1:42'), dict(maxSteps=0), dict(maxSteps=31), dict(timeoutMs=0)]:
            with self.assertRaises(ValueError): bridge.validate_request({**self.req, **delta})

    def test_harness_isolation_and_recording_defaults(self):
        with patch.dict(os.environ, {'BU_NAME': 'default', 'BU_CDP_WS': 'ws://user', 'BH_RECORD': '1'}, clear=True):
            bridge.configure_harness(self.req)
            self.assertEqual(os.environ['BU_CDP_URL'], 'http://127.0.0.1:34567')
            self.assertNotEqual(os.environ['BU_NAME'], 'default')
            self.assertNotIn('BU_CDP_WS', os.environ)
            self.assertEqual(os.environ['BH_RECORD'], '0')
            self.assertTrue(os.environ['BH_RUNTIME_DIR'].startswith(self.tmp.name))

    def test_harness_uses_owned_target_semantic_state_and_closes_its_tab_on_error(self):
        calls=[]; value=''; submitted=False
        def cdp(method, session_id=None, **params):
            nonlocal value, submitted
            calls.append((method,params))
            if method=='Target.createTarget':
                self.assertEqual(params, dict(url='about:blank',background=True)); return dict(targetId='owned-target')
            if method=='Target.attachToTarget':
                self.assertEqual(params['targetId'],'owned-target'); return dict(sessionId='owned-session')
            if method=='Target.closeTarget':
                self.assertEqual(params['targetId'],'owned-target'); return dict(success=True)
            self.assertEqual(session_id,'owned-session')
            if method=='Runtime.evaluate':
                expression=params['expression']
                if expression=='document.readyState': state='complete'
                elif 'SELECTOR' in expression: raise AssertionError('unexpanded expression')
                elif 'document.querySelectorAll' in expression and 'map(selector' not in expression: state=dict(x=12,y=15)
                else: state=[dict(exists=True,count=1,text='Verified '+value if submitted else 'Not verified',value=None)]
                return dict(result=dict(value=state))
            if method=='Input.insertText': value=params['text']
            if method=='Input.dispatchMouseEvent' and params['type']=='mouseReleased' and value: submitted=True
            return {}
        self.req['case']['tool']='browser-harness'
        self.req['case']['steps']=[dict(action='fill',selector='#name',value='Kodo'),dict(action='click',selector='#verify')]
        with patch.object(bridge,'harness_cdp',lambda:cdp): result=bridge.run_harness(self.req)
        self.assertEqual(result['observations'][0]['text'],'Verified Kodo')
        self.assertEqual(calls[-1][0],'Target.closeTarget')
        def failed(method, **kwargs):
            if method=='Page.navigate': return dict(errorText='net::ERR_CONNECTION_REFUSED')
            return cdp(method,**kwargs)
        with patch.object(bridge,'harness_cdp',lambda:failed):
            with self.assertRaises(ValueError): bridge.run_harness(self.req)
        self.assertEqual(calls[-1][0],'Target.closeTarget')

    def test_summary_cannot_turn_malformed_or_failed_qa_into_passing(self):
        valid = dict(high_severity=[], medium_severity=[], low_severity=[])
        self.assertEqual(bridge.strict_summary(valid), valid)
        for value in [{}, 'passing', {**valid, 'high_severity': 'none'}, {**valid, 'extra': []}]:
            with self.assertRaises(ValueError): bridge.strict_summary(value)

    def browser_modules(self, success=True):
        sessions = []
        kwargs_seen = []
        class Session:
            def __init__(self, **kwargs): self.kwargs=kwargs; self.stopped=False; sessions.append(self)
            async def stop(self): self.stopped=True
        class Profile:
            def __init__(self, **kwargs): self.kwargs=kwargs
        class Google:
            def __init__(self, **kwargs): kwargs_seen.append(kwargs)
        class Agent:
            def __init__(self, **kwargs): self.kwargs=kwargs; kwargs_seen.append(kwargs)
            async def run(self, max_steps):
                self.test_steps=max_steps; kwargs_seen.append(dict(max_steps=max_steps))
                history=types.SimpleNamespace(is_successful=lambda:success, final_result=lambda:'DONE', history=[1, 2])
                if self.kwargs.get('register_done_callback'): await self.kwargs['register_done_callback'](history)
                return history
        modules = {'browser_use': types.SimpleNamespace(Agent=Agent, BrowserSession=Session, BrowserProfile=Profile),
                   'browser_use.llm': types.SimpleNamespace(ChatGoogle=Google)}
        return modules, sessions, kwargs_seen

    def test_browser_use_calls_google_bounded_agent_and_observes_before_cleanup(self):
        modules, sessions, calls = self.browser_modules()
        async def observe(session, assertions, url):
            self.assertFalse(session.stopped)
            return [dict(exists=True, count=1, text='Saved', value=None)]
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {'GEMINI_API_KEY':'fake-for-test'}, clear=True), patch.object(bridge, 'observe_session', observe):
            result=asyncio.run(bridge.run_browser_use(self.req))
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(sessions[0].stopped)
        self.assertEqual(calls[0]['model'], 'gemini-4-argon')
        self.assertEqual(calls[-1]['max_steps'], 4)
        self.assertFalse(calls[1]['use_vision'])
        self.assertEqual(sessions[0].kwargs['cdp_url'], self.req['cdpUrl'])

    def test_jev_runs_real_agent_port_and_replaces_only_text_helper(self):
        events=[]
        original_helper=lambda context: 'must not call'
        class Browser:
            def evaluate(self, expression):
                events.append('observe')
                return [dict(exists=True, count=1, text='Saved', value=None)]
        class Agent:
            def __init__(self, url, goal, **kwargs):
                self.state={'history':[]}; self.browser=Browser()
                self_assert = kwargs == dict(screenshots=False, record_dir=None)
                if not self_assert: raise AssertionError('recording enabled')
                events.append('create')
            def command(self, name):
                self.state['history'].append(name); events.append(name)
                return dict(status='done')
            def close(self): events.append('close')
        module=types.ModuleType('jev_ultrafast.agent'); module.Agent=Agent; module.field_text=original_helper
        parent=types.ModuleType('jev_ultrafast'); parent.agent=module
        with patch.dict(sys.modules, {'jev_ultrafast':parent, 'jev_ultrafast.agent':module}), patch.dict(os.environ, {'GEMINI_API_KEY':'fake', 'TYPESAFE_API_KEY':'fake'}, clear=True), patch.object(bridge, 'harness_cdp', lambda: None):
            result=bridge.run_jev(self.req)
        self.assertEqual(result['observations'][0]['text'], 'Saved')
        self.assertEqual(events, ['create','tick','observe','close'])
        self.assertIs(module.field_text, original_helper)
        events.clear()
        def never_done(self, name): events.append(name); return dict(status='ready')
        Agent.command=never_done
        with patch.dict(sys.modules, {'jev_ultrafast':parent, 'jev_ultrafast.agent':module}), patch.dict(os.environ, {'GEMINI_API_KEY':'fake', 'TYPESAFE_API_KEY':'fake'}, clear=True), patch.object(bridge, 'harness_cdp', lambda: None):
            with self.assertRaises(ValueError): bridge.run_jev(self.req)
        self.assertEqual(events, ['create','tick','tick','tick','tick','close'])

    def test_vibetest_pool_adaptations_bound_actual_agents_and_reject_failure_fallback(self):
        for success in (True, False):
            modules, sessions, calls = self.browser_modules(success)
            pool=types.ModuleType('vibetest.agents')
            pool.Agent=modules['browser_use'].Agent
            pool.BrowserSession=modules['browser_use'].BrowserSession
            pool.BrowserProfile=modules['browser_use'].BrowserProfile
            pool.ChatGoogle=modules['browser_use.llm'].ChatGoogle
            pool.get_google_api_key=lambda:'wrong'
            pool._test_results={}
            # This dependency fixture preserves upstream swallowed-failure semantics.
            async def scout(url):
                session=pool.BrowserSession(browser_profile=pool.BrowserProfile(disable_security=True))
                try:
                    await pool.Agent(task='scout', llm=pool.ChatGoogle(model='wrong'), browser_session=session).run()
                except Exception: pass
                finally: await session.aclose()
                return ['focus 1','focus 2']
            pool.scout_page=scout
            async def run_pool(url, num_agents, headless):
                self.assertEqual((num_agents,headless),(2,True))
                tasks=await pool.scout_page(url)
                results=[]
                for task in tasks:
                    session=pool.BrowserSession(browser_profile=pool.BrowserProfile(disable_security=True))
                    try:
                        await pool.Agent(task=task,llm=pool.ChatGoogle(model='wrong'),browser_session=session,use_vision=True).run()
                        results.append(dict(status='success',result='QA report'))
                    except Exception: results.append(dict(status='error'))
                    finally: await session.aclose()
                pool._test_results['test']=dict(status='completed',results=results)
                return 'test'
            pool.run_pool=run_pool
            async def summary(test_id):
                response=await pool.ChatGoogle(model='wrong').ainvoke([])
                return dict(failed_agents=0, overall_status='passing')
            pool.summarize_bug_reports=summary
            async def google_invoke(self, messages, **kwargs):
                return types.SimpleNamespace(completion='{"high_severity":[],"medium_severity":[],"low_severity":[]}')
            modules['browser_use.llm'].ChatGoogle.ainvoke=google_invoke
            parent=types.ModuleType('vibetest');parent.agents=pool
            modules.update({'vibetest':parent,'vibetest.agents':pool})
            async def observe(*args): return [dict(exists=True,count=1,text='Saved',value=None)]
            req={**self.req,'cdpUrls':['http://127.0.0.1:34567','http://127.0.0.1:34568','http://127.0.0.1:34569']}
            original=pool.Agent
            with patch.dict(sys.modules,modules), patch.dict(os.environ,{'GEMINI_API_KEY':'fake'},clear=True), patch.object(bridge,'observe_session',observe):
                if success:
                    result=asyncio.run(bridge.run_vibetest(req))
                    self.assertEqual(result['status'],'completed')
                    self.assertEqual(len(result['qa']['observations']),2)
                else:
                    with self.assertRaises(ValueError): asyncio.run(bridge.run_vibetest(req))
            self.assertIs(pool.Agent,original)
            self.assertTrue(all(s.stopped for s in sessions))
            self.assertTrue(all(c['max_steps']==4 for c in calls if 'max_steps' in c))

    def test_unsuccessful_history_fails_even_with_done_and_correct_dom(self):
        modules, sessions, calls = self.browser_modules(False)
        async def observe(*args): return [dict(exists=True, count=1, text='Saved', value=None)]
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {'GEMINI_API_KEY':'fake-for-test'}, clear=True), patch.object(bridge, 'observe_session', observe):
            with self.assertRaises(ValueError): asyncio.run(bridge.run_browser_use(self.req))
        self.assertTrue(sessions[0].stopped)

if __name__ == '__main__': unittest.main()
